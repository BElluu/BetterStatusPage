import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import {
  ConfigExportError, ConfigInvalidError, createConfigEngine, createVaultExporter, createVaultResolver, documentKey, findCycle, isValidEntityKey,
  keyList, Problems, unknownFields, ENTITY_KEY_ERROR, type AuditEntry, type ConfigChange, type ConfigKind, type Json,
} from '@better-forge/config-as-code'

// Two kinds over an in-memory "installation": things, and boxes that name the things they hold.
interface State { things: Map<string, { id: number; name: string }>; boxes: Map<string, { id: number; items: string[] }>; vaults: Json[] }
interface DesiredThing { key: string; name: string }
interface DesiredBox { key: string; items: string[] }

let state: State
let nextId: number
let writes: string[]
let audits: string[]
let failApplyOf: string | null

const keys = { isValid: isValidEntityKey, error: ENTITY_KEY_ERROR }

const thing: ConfigKind<State, State, DesiredThing, DesiredThing[]> = {
  kind: 'Thing',
  parse(entry, index, seen, problems) {
    const key = documentKey(entry, `document ${index + 1}`, seen, problems, keys)
    unknownFields(entry, ['kind', 'key', 'name'], key || `document ${index + 1}`, problems)
    if (typeof entry['name'] !== 'string') problems.add(`Thing[${key}].name`, 'is required')
    return key && typeof entry['name'] === 'string' ? { key, name: entry['name'] } : null
  },
  plan(desired, ctx) {
    const changes: ConfigChange[] = desired.map((d) => {
      const existing = ctx.state.things.get(d.key)
      if (!existing) return { kind: 'Thing', key: d.key, action: 'create' }
      return existing.name === d.name ? { kind: 'Thing', key: d.key, action: 'unchanged' } : { kind: 'Thing', key: d.key, action: 'update', fields: ['name'] }
    })
    return { planned: desired.filter((_, i) => changes[i]!.action !== 'unchanged'), changes }
  },
  existingIds: (s) => new Map([...s.things].map(([key, row]) => [key, row.id])),
  async apply(planned, ctx) {
    const entries: AuditEntry[] = []
    for (const d of planned) {
      if (failApplyOf === d.key) throw new Error('write failed')
      const id = ctx.ids('Thing').get(d.key) ?? nextId++
      ctx.ids('Thing').set(d.key, id)
      state.things.set(d.key, { id, name: d.name })
      writes.push(`thing ${d.key}`)
      entries.push({ action: 'create', entity: 'thing', id, name: d.name, diff: { key: d.key } })
    }
    return entries
  },
  export: (s, ctx) => ctx.wanted([...s.things].map(([key, row]) => ({ key, name: row.name })), 'Thing').map((row) => ({ kind: 'Thing', ...row })),
}

const box: ConfigKind<State, State, DesiredBox, DesiredBox[]> = {
  kind: 'Box',
  parse(entry, index, seen, problems) {
    const key = documentKey(entry, `document ${index + 1}`, seen, problems, keys)
    const items = keyList(entry['items'], `Box[${key}].items`, problems, isValidEntityKey)
    return key ? { key, items } : null
  },
  plan(desired, ctx) {
    for (const d of desired) {
      const known = new Set([...ctx.state.things.keys(), ...ctx.desired('Thing').map((t) => (t as DesiredThing).key)])
      for (const item of d.items) if (!known.has(item)) ctx.problems.add(`Box[${d.key}].items`, `unknown thing "${item}"`)
    }
    return { planned: desired, changes: desired.map((d) => ({ kind: 'Box', key: d.key, action: ctx.state.boxes.has(d.key) ? 'unchanged' : 'create' })) }
  },
  existingIds: (s) => new Map([...s.boxes].map(([key, row]) => [key, row.id])),
  async apply(planned, ctx) {
    for (const d of planned) {
      if (ctx.state.boxes.has(d.key)) continue
      const id = nextId++
      ctx.ids('Box').set(d.key, id)
      writes.push(`box ${d.key}`)
      state.boxes.set(d.key, { id, items: [] })
    }
    return planned.filter((d) => !ctx.state.boxes.has(d.key) || true).map((d) => ({ action: 'create' as const, entity: 'box', id: ctx.ids('Box').get(d.key)!, name: d.key, diff: {} }))
  },
  async link(planned, ctx) {
    // Runs after every kind is written: a box may name a thing created later in the same file.
    for (const d of planned) {
      const row = state.boxes.get(d.key)!
      row.items = d.items.map((item) => `${item}#${ctx.ids('Thing').get(item)}`)
      writes.push(`link ${d.key}`)
    }
  },
  export: (s, ctx) => ctx.wanted([...s.boxes].map(([key, row]) => ({ key, items: row.items })), 'Box').map((row) => ({ kind: 'Box', ...row })),
}

let transactions: number
let afterApplied: number

function engine() {
  return createConfigEngine<State, State, string>({
    // Messages name kinds in this order; they are planned and written in the order Thing, Box.
    kinds: [box, thing],
    order: ['Thing', 'Box'],
    loadState: async () => state,
    loadExportState: async () => state,
    vaultRows: (s) => ({ vaults: s.vaults as never, secrets: [] }),
    exportVaultRows: (s) => ({ vaults: s.vaults as never, secrets: [] }),
    transaction: async (work) => {
      transactions++
      const snapshot = structuredClone({ things: [...state.things], boxes: [...state.boxes], nextId })
      try { return await work() } catch (error) {
        state.things = new Map(snapshot.things)
        state.boxes = new Map(snapshot.boxes)
        throw error
      }
    },
    audit: { write: async (actor, action, entity, id, name) => { audits.push(`${actor}:${action}:${entity}:${String(id)}:${name}`) } },
    afterApply: async () => { afterApplied++ },
  })
}

beforeEach(() => {
  state = { things: new Map(), boxes: new Map(), vaults: [] }
  nextId = 1
  writes = []
  audits = []
  failApplyOf = null
  transactions = 0
  afterApplied = 0
})
afterEach(() => mock.restoreAll())

const apply = (documents: unknown[], dryRun = false) => engine().importDocuments(documents, { dryRun, actor: 'me' })
const problemsOf = async (documents: unknown[]) => {
  try { await apply(documents, true) } catch (error) {
    assert.ok(error instanceof ConfigInvalidError)
    return error.problems.map((p) => `${p.path}: ${p.message}`)
  }
  assert.fail('expected the file to be refused')
}

describe('reading a file', () => {
  it('names the kinds in registration order when a document has none or an unknown one', async () => {
    assert.deepEqual(await problemsOf([{ key: 'x' }]), ['document 1.kind: is required: one of Box, Thing'])
    assert.deepEqual(await problemsOf([{ kind: 'Nope' }]), ['document 1.kind: "Nope" is not a kind; use one of Box, Thing'])
    assert.deepEqual(await problemsOf(['text']), ['document 1: must be an object with a kind'])
  })

  it('refuses a duplicate or invalid key, an unknown field, and a name that would poison an object', async () => {
    assert.deepEqual(await problemsOf([{ kind: 'Thing', key: 'a', name: 'A' }, { kind: 'Thing', key: 'a', name: 'B' }]), ['document 2.key: "a" is used by another document'])
    assert.deepEqual(await problemsOf([{ kind: 'Thing', key: 'Bad Key', name: 'A' }]), [`document 1.key: ${ENTITY_KEY_ERROR}`])
    assert.deepEqual(await problemsOf([{ kind: 'Thing', name: 'A' }]), ['document 1.key: is required'])
    assert.deepEqual(await problemsOf([{ kind: 'Thing', key: 'a', name: 'A', extra: 1 }]), ['a.extra: is not a known setting'])
    assert.deepEqual(await problemsOf([JSON.parse('{"kind":"Thing","key":"a","name":"A","x":{"__proto__":1}}')]), ['document 1.x.__proto__: "__proto__" is not allowed as a name'])
  })

  it('allows the same key in two kinds', async () => {
    const result = await apply([{ kind: 'Thing', key: 'a', name: 'A' }, { kind: 'Box', key: 'a', items: ['a'] }], true)
    assert.equal(result.summary.create, 2)
  })

  it('reports at most 100 problems', async () => {
    const documents = Array.from({ length: 150 }, () => ({ key: 'x' }))
    assert.equal((await problemsOf(documents)).length, 100)
  })

  it('tells which kinds a list of documents holds', () => {
    assert.deepEqual([...engine().kindsIn([{ kind: 'Box' }, { kind: 'Nope' }, 'x', null, { kind: 'Box' }])], ['Box'])
  })
})

describe('applying a file', () => {
  const file = [{ kind: 'Box', key: 'b', items: ['t'] }, { kind: 'Thing', key: 't', name: 'T' }]

  it('plans in kind order, writes nothing on a dry run and reports what would change', async () => {
    const result = await apply(file, true)
    assert.deepEqual(result, { dryRun: true, summary: { create: 2, update: 0, unchanged: 0 }, changes: [{ kind: 'Thing', key: 't', action: 'create' }, { kind: 'Box', key: 'b', action: 'create' }] })
    assert.deepEqual([writes, audits, transactions], [[], [], 0])
  })

  it('writes in kind order, links after every kind is written, audits each change and the summary, once', async () => {
    const result = await apply(file)
    assert.equal(result.dryRun, false)
    assert.deepEqual(writes, ['thing t', 'box b', 'link b'])
    assert.equal(state.boxes.get('b')!.items[0], 't#1')
    assert.deepEqual(audits, ['me:create:thing:1:T', 'me:create:box:2:b', 'me:update:config:null:Configuration import'])
    assert.equal(afterApplied, 1)
    assert.equal(transactions, 1)
  })

  it('does nothing, and audits nothing, when the file changes nothing', async () => {
    await apply(file)
    writes = []; audits = []; afterApplied = 0
    const again = await apply([{ kind: 'Thing', key: 't', name: 'T' }])
    assert.deepEqual(again.summary, { create: 0, update: 0, unchanged: 1 })
    assert.deepEqual([writes, audits, afterApplied], [[], [], 0])
  })

  it('reports what differs in an update, never the values', async () => {
    await apply(file)
    const result = await apply([{ kind: 'Thing', key: 't', name: 'Renamed' }], true)
    assert.deepEqual(result.changes, [{ kind: 'Thing', key: 't', action: 'update', fields: ['name'] }])
  })

  it('refuses the whole file when a reference is unknown, before anything is written', async () => {
    await assert.rejects(() => apply([{ kind: 'Box', key: 'b', items: ['ghost'] }]), (error: ConfigInvalidError) => {
      assert.deepEqual(error.problems, [{ path: 'Box[b].items', message: 'unknown thing "ghost"' }])
      assert.equal(error.message, 'Box[b].items: unknown thing "ghost"')
      return true
    })
    assert.deepEqual([writes, transactions], [[], 1])
  })

  it('rolls everything back when a write fails', async () => {
    failApplyOf = 'b'
    await assert.rejects(() => apply([{ kind: 'Thing', key: 'a', name: 'A' }, { kind: 'Thing', key: 'b', name: 'B' }]), /write failed/)
    assert.equal(state.things.size, 0)
    assert.deepEqual(audits, [])
  })

  it('logs, and does not fail, when the follow-up work after the commit fails', async () => {
    const error = mock.method(console, 'error', () => undefined)
    const failing = createConfigEngine<State, State, string>({
      kinds: [thing], loadState: async () => state, loadExportState: async () => state, vaultRows: () => ({ vaults: [], secrets: [] }), exportVaultRows: () => ({ vaults: [], secrets: [] }),
      transaction: (work) => work(), audit: { write: async () => { throw new Error('audit down') } },
    })
    const result = await failing.importDocuments([{ kind: 'Thing', key: 'a', name: 'A' }], { dryRun: false, actor: 'me' })
    assert.equal(result.summary.create, 1)
    assert.equal(error.mock.callCount(), 1)
    assert.match(String(error.mock.calls[0]!.arguments[0]), /Imported, but could not finish/)
  })
})

describe('exporting', () => {
  beforeEach(async () => { await apply([{ kind: 'Thing', key: 'b', name: 'B' }, { kind: 'Thing', key: 'a', name: 'A' }, { kind: 'Box', key: 'x', items: ['a'] }]) })

  it('writes the kinds in plan order', async () => {
    assert.deepEqual((await engine().exportDocuments()).map((d) => `${d['kind']}:${d['key']}`), ['Thing:b', 'Thing:a', 'Box:x'])
  })

  it('writes one document, leaves out kinds, and picks a document', async () => {
    const e = engine()
    assert.deepEqual(await e.exportDocuments({ kind: 'Thing', key: 'a' }), [{ kind: 'Thing', key: 'a', name: 'A' }])
    assert.deepEqual((await e.exportDocuments(undefined, { included: new Set(['Box']) })).map((d) => d['kind']), ['Box'])
    const all = await e.exportDocuments()
    assert.equal(e.pickDocument(all, 'Box', 'x')?.['key'], 'x')
    assert.equal(e.pickDocument(all, 'Box', 'nope'), undefined)
  })
})

describe('helpers', () => {
  it('finds a cycle and names it', () => {
    assert.equal(findCycle(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]])), 'a → b → c → a')
    assert.equal(findCycle(new Map([['a', ['b']], ['b', []]])), null)
    assert.equal(findCycle(new Map([['a', ['a']]])), 'a → a')
  })

  it('names vault secrets instead of numbering them, and turns names back into ids', () => {
    const rows = { vaults: [{ id: 1, name: 'Prod' }, { id: 2, name: 'Dup' }, { id: 3, name: 'Dup' }], secrets: [{ id: 10, vaultId: 1, name: 'db' }] }
    const out = createVaultExporter(rows)
    assert.deepEqual(out({ a: [{ vault: { vaultId: 1, secretId: 10, fieldMapping: { u: 'x' } } }] }), { a: [{ vault: { vault: 'Prod', secret: 'db', fieldMapping: { u: 'x' } } }] })
    assert.deepEqual(out({ vault: { vaultId: 9, secretId: 10 } }), { vault: { vault: '(deleted vault 9)', secret: '(deleted secret 10)' } })
    assert.deepEqual(out({ vault: { vaultId: 1, secretId: 99 } }), { vault: { vault: 'Prod', secret: '(deleted secret 99)' } })
    assert.throws(() => out({ vault: { vaultId: 2, secretId: 10 } }), ConfigExportError)

    const resolve = createVaultResolver(rows)
    const problems = new Problems()
    assert.deepEqual(resolve({ vault: { vault: 'Prod', secret: 'db' } }, 'c', problems), { vault: { vaultId: 1, secretId: 10 } })
    assert.equal(problems.any, false)
    for (const [value, message] of [
      [{ vault: 'x' }, /must name the vault and the secret/], [{ vault: { vault: 'Nope', secret: 'db' } }, /unknown vault "Nope"/],
      [{ vault: { vault: '(deleted vault 9)', secret: 'db' } }, /refers to a vault that no longer exists/], [{ vault: { vault: 'Dup', secret: 'db' } }, /more than one vault is named "Dup"/],
      [{ vault: { vault: 'Prod', secret: 'zz' } }, /has no secret "zz"/], [{ vault: { vault: 'Prod', secret: '(deleted secret 5)' } }, /refers to a secret that no longer exists/],
      [{ vault: { vault: 'Prod', secret: 'db', vaultId: 1 } }, /does not use numeric ids/],
    ] as const) {
      const found = new Problems()
      resolve(value, 'c', found)
      assert.match(found.list[0]!.message, message)
    }
  })
})
