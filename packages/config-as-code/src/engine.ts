import { clip, ConfigInvalidError, createVaultExporter, createVaultResolver, forbiddenNameAt, isObject, Problems, type Json, type VaultRows } from './document.js'

export type ChangeAction = 'create' | 'update' | 'unchanged'

export interface ConfigChange {
  kind: string
  /** The key of the object the document describes. */
  key?: string
  action: ChangeAction
  /** For an update: which settings differ. Never their values, which may be secrets. */
  fields?: string[]
}

export interface ImportResult {
  dryRun: boolean
  summary: Record<ChangeAction, number>
  changes: ConfigChange[]
}

/** What one change did, for the audit log. */
export interface AuditEntry { action: 'create' | 'update'; entity: string; id: number | string; name: string; diff: Json }

export interface ImportOptions<Actor> {
  dryRun: boolean
  actor: Actor
  /** Set when the request is made with an API token: what it may do is decided per kind. */
  token?: { scopes: readonly string[] } | undefined
}

/** What a kind sees while it reads the documents of a file. */
export interface PlanContext<State> {
  state: State
  token: { scopes: readonly string[] } | undefined
  problems: Problems
  /** `{ vault: <name>, secret: <name> }` references in a config, turned into the ids of this installation. */
  resolveVaults: (value: unknown, path: string) => unknown
  /** The documents of a kind the file holds, as that kind parsed them. */
  desired: (kind: string) => unknown[]
}

/** What a kind sees while it writes. */
export interface ApplyContext<State> {
  state: State
  now: number
  /** Ids by key, per kind: the objects that exist now, plus those created so far in this run. */
  ids: (kind: string) => Map<string, number>
}

/**
 * One kind of document. `parse` reads a document of the kind (reporting problems), `plan` compares what the file
 * holds with the installation and says what would change, `apply` writes it, `link` runs after every kind is written
 * (for references to objects that might be created later in the same file), `export` writes the kind out.
 */
export interface ConfigKind<State, ExportState, Desired = any, Planned = any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  kind: string
  parse: (entry: Json, index: number, seen: Set<string>, problems: Problems) => Desired | null
  plan: (desired: Desired[], ctx: PlanContext<State>) => { planned: Planned; changes: ConfigChange[] }
  /** The ids of the objects of this kind that exist, by key. */
  existingIds: (state: State) => Map<string, number>
  apply: (planned: Planned, ctx: ApplyContext<State>) => Promise<AuditEntry[]>
  link?: (planned: Planned, ctx: ApplyContext<State>) => Promise<void>
  /** The documents of this kind, sorted by key. `only` limits them to one key (and nothing else is written out). */
  export: (state: ExportState, ctx: ExportContext) => Json[]
}

export interface ExportContext {
  /** Replaces the vault references of a config with the names of the vault and secret. */
  exportVaultRefs: (value: unknown) => unknown
  /** The rows to write out: all of them, or only the one asked for. */
  wanted: <T extends { key: string }>(rows: T[], kind: string) => T[]
  /** Whether the kind is part of this export (a kind may be left out for a reader who may not see it). */
  included: (kind: string) => boolean
}

export interface ConfigEngineOptions<State, ExportState, Actor> {
  /** The kinds, in the order messages name them. */
  kinds: ReadonlyArray<ConfigKind<State, ExportState>>
  /** The order kinds are planned, written and exported in (kind names); defaults to `kinds`. */
  order?: readonly string[]
  /** Reads what the installation holds. Called inside the transaction when the file is applied. */
  loadState: () => Promise<State>
  /** Reads what an export needs; a kind not in `included` need not be read. */
  loadExportState: (included: ReadonlySet<string>) => Promise<ExportState>
  vaultRows: (state: State) => VaultRows
  exportVaultRows: (state: ExportState) => VaultRows
  /** Runs `work` so that everything it writes happens, or none of it does. */
  transaction: <T>(work: () => Promise<T>) => Promise<T>
  audit: { write: (actor: Actor, action: 'create' | 'update', entity: string, id: number | string | null, name: string, diff?: Json) => Promise<void> }
  /** Runs once after a successful apply that changed something, before the audit entries are written. */
  afterApply?: () => Promise<void>
  /** Entity type of the summary entry written to the audit log. */
  auditEntity?: string
}

/** Makes the installation match the documents, completely or not at all, and writes it out again as documents. */
export function createConfigEngine<State, ExportState, Actor>(options: ConfigEngineOptions<State, ExportState, Actor>) {
  const kinds = new Map(options.kinds.map((kind) => [kind.kind, kind]))
  const names = options.kinds.map((kind) => kind.kind)
  const order = (options.order ?? names).map((name) => kinds.get(name)!)

  /** The kinds a list of documents contains, so that the caller can check it may import each. Documents of no known kind are ignored here. */
  function kindsIn(documents: unknown[]): Set<string> {
    const found = new Set<string>()
    for (const document of documents) {
      if (isObject(document) && names.includes(document['kind'] as string)) found.add(document['kind'] as string)
    }
    return found
  }

  function parseDocuments(documents: unknown[], problems: Problems): Map<string, unknown[]> {
    const desired = new Map<string, unknown[]>(names.map((name) => [name, []]))
    const seenKeys = new Map<string, Set<string>>(names.map((name) => [name, new Set()]))

    documents.forEach((document, index) => {
      const label = `document ${index + 1}`
      const poisoned = forbiddenNameAt(document, label)
      if (poisoned) { problems.add(poisoned, '"__proto__" is not allowed as a name'); return }
      if (!isObject(document)) { problems.add(label, 'must be an object with a kind'); return }

      const kind = kinds.get(document['kind'] as string)
      if (!kind) {
        problems.add(`${label}.kind`, document['kind'] === undefined
          ? `is required: one of ${names.join(', ')}`
          : `"${clip(String(document['kind']))}" is not a kind; use one of ${names.join(', ')}`)
        return
      }
      const parsed = kind.parse(document, index, seenKeys.get(kind.kind)!, problems)
      if (parsed) desired.get(kind.kind)!.push(parsed)
    })
    return desired
  }

  function plan(state: State, desired: Map<string, unknown[]>, token: ImportOptions<Actor>['token']) {
    const problems = new Problems()
    const resolve = createVaultResolver(options.vaultRows(state))
    const ctx: PlanContext<State> = {
      state, token, problems,
      resolveVaults: (value, path) => resolve(value, path, problems),
      desired: (kind) => desired.get(kind) ?? [],
    }
    const planned = new Map<string, unknown>()
    const changes: ConfigChange[] = []
    for (const kind of order) {
      const result = kind.plan(desired.get(kind.kind) ?? [], ctx)
      planned.set(kind.kind, result.planned)
      changes.push(...result.changes)
    }
    if (problems.any) throw new ConfigInvalidError(problems.list)
    return { planned, changes }
  }

  async function execute(state: State, planned: Map<string, unknown>): Promise<AuditEntry[]> {
    const ids = new Map(names.map((name) => [name, kinds.get(name)!.existingIds(state)]))
    const ctx: ApplyContext<State> = { state, now: Date.now(), ids: (kind) => ids.get(kind)! }
    const audit: AuditEntry[] = []
    for (const kind of order) audit.push(...await kind.apply(planned.get(kind.kind), ctx))
    for (const kind of order) await kind.link?.(planned.get(kind.kind), ctx)
    return audit
  }

  function summarise(changes: ConfigChange[]): ImportResult['summary'] {
    const summary = { create: 0, update: 0, unchanged: 0 }
    for (const change of changes) summary[change.action] += 1
    return summary
  }

  /**
   * Makes the installation match the documents: an object whose key exists is updated, one whose key does not is created.
   * Nothing is ever removed. Everything is checked before anything is written, and the writes are one transaction, so a
   * stream is applied completely or not at all. With `dryRun` nothing is written and the result says what would happen.
   */
  async function importDocuments(documents: unknown[], importOptions: ImportOptions<Actor>): Promise<ImportResult> {
    const problems = new Problems()
    const desired = parseDocuments(documents, problems)
    if (problems.any) throw new ConfigInvalidError(problems.list)

    const result = (changes: ConfigChange[]): ImportResult => ({ dryRun: importOptions.dryRun, summary: summarise(changes), changes })

    if (importOptions.dryRun) return result(plan(await options.loadState(), desired, importOptions.token).changes)

    const { changes, audit } = await options.transaction(async () => {
      const state = await options.loadState()
      const { planned, changes } = plan(state, desired, importOptions.token)
      const audit = changes.some((change) => change.action !== 'unchanged') ? await execute(state, planned) : []
      return { changes, audit }
    })

    // The changes are committed. A failure past this point must not turn a successful import into an error (the
    // client would retry, and a second apply is a no-op), so it is logged instead.
    if (audit.length) {
      try {
        await options.afterApply?.()
        for (const entry of audit) await options.audit.write(importOptions.actor, entry.action, entry.entity, entry.id, entry.name, entry.diff)
        const summary = summarise(changes)
        await options.audit.write(importOptions.actor, 'update', options.auditEntity ?? 'config', null, 'Configuration import', {
          created: summary.create, updated: summary.update, unchanged: summary.unchanged,
        })
      } catch (error) {
        console.error('[config] Imported, but could not finish the follow-up work:', error)
      }
    }
    return result(changes)
  }

  /**
   * The documents of every kind, in a fixed order that does not depend on this installation's numeric ids. Secrets are
   * masked by the kinds, and runtime state is left out. `only` writes out one document; `included` leaves out kinds.
   */
  async function exportDocuments(only?: { kind: string; key: string }, exportOptions: { included?: ReadonlySet<string> } = {}): Promise<Json[]> {
    const included = exportOptions.included ?? new Set(names)
    const state = await options.loadExportState(included)
    const ctx: ExportContext = {
      exportVaultRefs: createVaultExporter(options.exportVaultRows(state)),
      // Only the rows asked for are written out, so a vault name that is ambiguous for some other object does not matter.
      wanted: (rows, kind) => (only ? rows.filter((row) => only.kind === kind && row.key === only.key) : rows),
      included: (kind) => included.has(kind),
    }
    return order.filter((kind) => included.has(kind.kind)).flatMap((kind) => kind.export(state, ctx))
  }

  /** The one document of a kind and key, or undefined when there is none. */
  function pickDocument(documents: Json[], kind: string, key: string | undefined): Json | undefined {
    return documents.find((document) => document['kind'] === kind && document['key'] === key)
  }

  return { kinds: names, kindsIn, importDocuments, exportDocuments, pickDocument }
}

export type ConfigEngine<State, ExportState, Actor> = ReturnType<typeof createConfigEngine<State, ExportState, Actor>>
