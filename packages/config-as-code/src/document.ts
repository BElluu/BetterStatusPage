export type Json = Record<string, unknown>
export const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)

export interface ConfigProblem { path: string; message: string }

/** The file is not valid; `problems` lists what is wrong with it, not just the first thing. */
export class ConfigInvalidError extends Error {
  constructor(readonly problems: ConfigProblem[]) {
    super(problems[0] ? `${problems[0].path}: ${problems[0].message}` : 'Invalid configuration')
  }
}

/** Most problems a file reports: the first ones are the ones to fix first. */
const MAX_PROBLEMS = 100

/** Collects what is wrong with a file. */
export class Problems {
  readonly list: ConfigProblem[] = []
  add = (path: string, message: string) => { if (this.list.length < MAX_PROBLEMS) this.list.push({ path, message }) }
  get any() { return this.list.length > 0 }
}

/** Shortens text that comes from a request before it is repeated in an answer, so an error cannot be made to echo a megabyte. */
export function clip(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** Whether `value` nests objects or lists deeper than `max` levels. Checked without recursion, so it cannot overflow the stack. */
export function nestedDeeperThan(value: unknown, max: number): boolean {
  const pending: Array<[unknown, number]> = [[value, 0]]
  while (pending.length) {
    const [current, depth] = pending.pop()!
    if (!current || typeof current !== 'object') continue
    if (depth >= max) return true
    for (const inner of Object.values(current)) pending.push([inner, depth + 1])
  }
  return false
}

/** The same value written with its keys in a fixed order, so equal settings compare equal whatever their order. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => isObject(inner) ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]])) : inner)
}

/** Orders documents by key. A tie sorts the second one first, which never happens: keys are unique. */
export const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : 1)

/** Reports every field of `entry` that is not in `allowed`. */
export function unknownFields(entry: Json, allowed: readonly string[], path: string, problems: Problems): void {
  for (const field of Object.keys(entry)) if (!allowed.includes(field)) problems.add(`${path}.${clip(field)}`, 'is not a known setting')
}

/** Where a name the parser would treat specially (`__proto__`) appears in a document, or null. Walks without recursion. */
export function forbiddenNameAt(document: unknown, label: string): string | null {
  const pending: Array<[unknown, string]> = [[document, label]]
  while (pending.length) {
    const [value, path] = pending.pop()!
    if (!value || typeof value !== 'object') continue
    if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, '__proto__')) return `${path}.__proto__`
    const entries: Array<[string, unknown]> = Array.isArray(value) ? value.map((item, index) => [`[${index}]`, item]) : Object.entries(value)
    for (const [name, inner] of entries) pending.push([inner, name.startsWith('[') ? `${path}${name}` : `${path}.${clip(name)}`])
  }
  return null
}

/** A dependency cycle among `edges` (key -> keys it depends on), as `a → b → a`, or null. */
export function findCycle(edges: Map<string, string[]>): string | null {
  const done = new Set<string>()
  const stack: string[] = []
  const visit = (key: string): string | null => {
    const at = stack.indexOf(key)
    if (at >= 0) return [...stack.slice(at), key].join(' → ')
    if (done.has(key)) return null
    stack.push(key)
    for (const next of edges.get(key) ?? []) {
      const cycle = visit(next)
      if (cycle) return cycle
    }
    stack.pop()
    done.add(key)
    return null
  }
  for (const key of edges.keys()) {
    const cycle = visit(key)
    if (cycle) return cycle
  }
  return null
}

// ── References to vault secrets ──────────────────────────────────────────────

/** The vaults and secrets of an installation, as far as a file needs to name them. */
export interface VaultRows {
  vaults: ReadonlyArray<{ id: number; name: string }>
  secrets: ReadonlyArray<{ id: number; vaultId: number; name: string }>
}

/** A vault secret named instead of numbered, so the file means the same on another installation. */
export interface ConfigVaultRef { vault: string; secret: string; fieldMapping?: Record<string, string> }

/** `{ vault: 'Production', secret: 'db-login' }` back to the ids this installation knows them by. */
export function createVaultResolver(rows: VaultRows) {
  const vaultsByName = new Map<string, number[]>()
  for (const vault of rows.vaults) vaultsByName.set(vault.name, [...(vaultsByName.get(vault.name) ?? []), vault.id])
  const secretId = new Map(rows.secrets.map((secret) => [`${secret.vaultId}:${secret.name}`, secret.id]))

  return function resolve(value: unknown, path: string, problems: Problems): unknown {
    if (Array.isArray(value)) return value.map((item, index) => resolve(item, `${path}[${index}]`, problems))
    if (!isObject(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => {
      if (key !== 'vault') return [key, resolve(inner, `${path}.${key}`, problems)]
      const at = `${path}.vault`
      if (!isObject(inner) || typeof inner['vault'] !== 'string' || typeof inner['secret'] !== 'string') {
        problems.add(at, 'must name the vault and the secret: { vault: <name>, secret: <name> }')
        return [key, inner]
      }
      if ('vaultId' in inner || 'secretId' in inner) problems.add(at, 'a configuration file names a vault secret, it does not use numeric ids')
      const found = vaultsByName.get(inner['vault']) ?? []
      if (found.length !== 1) {
        problems.add(at, found.length === 0
          ? (inner['vault'].startsWith('(deleted') ? `${clip(inner['vault'])} refers to a vault that no longer exists` : `unknown vault "${clip(inner['vault'])}"`)
          : `more than one vault is named "${clip(inner['vault'])}"; rename one of them`)
        return [key, inner]
      }
      const secret = secretId.get(`${found[0]}:${inner['secret']}`)
      if (secret === undefined) {
        problems.add(at, inner['secret'].startsWith('(deleted') ? `${clip(inner['secret'])} refers to a secret that no longer exists` : `vault "${clip(inner['vault'])}" has no secret "${clip(inner['secret'])}"`)
        return [key, inner]
      }
      return [key, { vaultId: found[0], secretId: secret, ...(isObject(inner['fieldMapping']) ? { fieldMapping: inner['fieldMapping'] } : {}) }]
    }))
  }
}

/** The file would refer to something it cannot name unambiguously, so it could not be read back. */
export class ConfigExportError extends Error {}

const deleted = (what: string, id: unknown) => `(deleted ${what} ${String(id)})`

function isVaultRef(value: unknown): value is { vaultId: number; secretId: number; fieldMapping?: unknown } {
  return isObject(value) && typeof value['vaultId'] === 'number' && typeof value['secretId'] === 'number'
}

/** Replaces every `vault: { vaultId, secretId }` reference in a config with the names of the vault and secret. */
export function createVaultExporter(rows: VaultRows) {
  const nameCount = new Map<string, number>()
  for (const vault of rows.vaults) nameCount.set(vault.name, (nameCount.get(vault.name) ?? 0) + 1)
  const vaultName = new Map(rows.vaults.map((vault) => [vault.id, vault.name]))
  const secret = new Map(rows.secrets.map((row) => [row.id, row]))

  function exportRef(ref: { vaultId: number; secretId: number; fieldMapping?: unknown }): ConfigVaultRef {
    const vault = vaultName.get(ref.vaultId)
    const found = secret.get(ref.secretId)
    if (vault !== undefined && (nameCount.get(vault) ?? 0) > 1) {
      throw new ConfigExportError(`More than one vault is named "${vault}", so a reference to it cannot be exported. Rename one of them.`)
    }
    return {
      vault: vault ?? deleted('vault', ref.vaultId),
      secret: found && found.vaultId === ref.vaultId ? found.name : deleted('secret', ref.secretId),
      ...(isObject(ref.fieldMapping) ? { fieldMapping: ref.fieldMapping as Record<string, string> } : {}),
    }
  }

  return function exportRefs(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => exportRefs(item))
    if (!isObject(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, inner]) =>
      [key, key === 'vault' && isVaultRef(inner) ? exportRef(inner) : exportRefs(inner)]))
  }
}

// ── Fields every kind of document reads the same way ─────────────────────────

/** A list of keys (`notifications: [a, b]`), without repeats; problems are reported at `path`. */
export function keyList(value: unknown, path: string, problems: Problems, isValidKey: (key: unknown) => boolean): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    problems.add(path, 'must be a list of keys')
    return []
  }
  for (const key of value) if (!isValidKey(key)) problems.add(path, `"${clip(key)}" is not a valid key`)
  return [...new Set(value as string[])]
}

/** The key of a document, or '' (with a problem) when it has none that is usable; a repeat within `seen` is a problem too. */
export function documentKey(
  entry: Json, path: string, seen: Set<string>, problems: Problems,
  keys: { isValid: (key: unknown) => boolean; error: string },
): string {
  const key = entry['key']
  if (!keys.isValid(key)) {
    problems.add(`${path}.key`, key === undefined ? 'is required' : keys.error)
    return ''
  }
  const text = key as string
  if (seen.has(text)) problems.add(`${path}.key`, `"${clip(text)}" is used by another document`)
  seen.add(text)
  return text
}
