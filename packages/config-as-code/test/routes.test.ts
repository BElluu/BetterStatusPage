import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import { parseAllDocuments } from 'yaml'
import {
  ConfigExportError, createConfigEngine, createConfigRoutes, type ConfigCaller, type ConfigKind, type Json,
} from '@better-forge/config-as-code'

// Two kinds over a list in memory: "Note" (anyone who may write notes) and "Secret" (administrators; optional in a full export).
const store = { Note: new Map<string, string>(), Secret: new Map<string, string>() }
let exportFails = false
let imports: Array<{ dryRun: boolean; actor: string; scopes: readonly string[] | undefined }>

function kindOf(name: 'Note' | 'Secret'): ConfigKind<undefined, undefined, { key: string; text: string }, Array<{ key: string; text: string }>> {
  return {
    kind: name,
    parse: (entry, _index, _seen, problems) => {
      if (typeof entry['text'] !== 'string') { problems.add(`${name}.text`, 'is required'); return null }
      return { key: String(entry['key']), text: entry['text'] }
    },
    plan: (desired) => ({ planned: desired, changes: desired.map((d) => ({ kind: name, key: d.key, action: store[name].has(d.key) ? 'unchanged' : 'create' as const })) }),
    existingIds: () => new Map(),
    apply: async (planned) => { for (const d of planned) store[name].set(d.key, d.text); return [] },
    export: (_state, ctx) => {
      if (exportFails) throw new ConfigExportError('cannot be written back')
      return ctx.wanted([...store[name]].map(([key, text]) => ({ key, text })), name).map((row) => ({ kind: name, ...row }) as Json)
    },
  }
}

let caller: ConfigCaller
let app: FastifyInstance

beforeEach(async () => {
  store.Note.clear(); store.Secret.clear()
  store.Note.set('n1', 'first'); store.Secret.set('s1', 'hidden')
  exportFails = false
  imports = []
  caller = { role: 'admin' }
  const base = createConfigEngine<undefined, undefined, string>({
    kinds: [kindOf('Note'), kindOf('Secret')], loadState: async () => undefined, loadExportState: async () => undefined,
    vaultRows: () => ({ vaults: [], secrets: [] }), exportVaultRows: () => ({ vaults: [], secrets: [] }),
    transaction: (work) => work(), audit: { write: async () => undefined },
  })
  const engine = { ...base, importDocuments: async (...args: Parameters<typeof base.importDocuments>) => {
    imports.push({ dryRun: args[1].dryRun, actor: args[1].actor, scopes: args[1].token?.scopes })
    return base.importDocuments(...args)
  } }
  app = Fastify({ logger: false })
  await app.register(createConfigRoutes<string>({
    engine,
    access: {
      Note: { tokenResource: 'notes', roles: ['admin', 'editor'], roleLabel: 'editor' },
      Secret: { tokenResource: 'secrets', roles: ['admin'], roleLabel: 'admin', optional: true },
    },
    identity: () => caller,
    actor: () => 'actor',
    guards: [async (_req, reply) => { if (caller.role === 'guest') return reply.code(403).send({ error: 'Forbidden' }) }],
    linkedKinds: (documents) => documents.some((d) => (d as { link?: unknown }).link === true) ? ['Secret'] : [],
  }), { prefix: '/config' })
  await app.ready()
})

afterEach(() => app.close())

const post = (path: string, payload: string, type = 'application/yaml') => app.inject({ method: 'POST', url: `/config/${path}`, headers: { 'content-type': type }, payload })

describe('export', () => {
  it('writes every kind as YAML documents, or one document by kind and key', async () => {
    const all = await app.inject('/config/export')
    assert.equal(all.headers['content-type'], 'application/yaml; charset=utf-8')
    assert.deepEqual(parseAllDocuments(all.body).map((d) => d.toJS()), [{ kind: 'Note', key: 'n1', text: 'first' }, { kind: 'Secret', key: 's1', text: 'hidden' }])
    assert.deepEqual(parseAllDocuments((await app.inject('/config/export?kind=Secret&key=s1')).body).map((d) => d.toJS()), [{ kind: 'Secret', key: 's1', text: 'hidden' }])
  })

  it('refuses an unknown kind, a kind without a key and a document that is not there', async () => {
    assert.deepEqual((await app.inject('/config/export?kind=Nope&key=x')).json(), { error: 'kind must be one of: Note, Secret' })
    assert.deepEqual((await app.inject('/config/export?kind=Note')).json(), { error: 'key is required to export a Note' })
    const missing = await app.inject('/config/export?kind=Note&key=ghost')
    assert.equal(missing.statusCode, 404)
    assert.equal(missing.json().error, 'There is no Note with the key "ghost"')
  })

  it('leaves out an optional kind for a reader who may not see it, but refuses to export it by name', async () => {
    caller = { role: 'editor' }
    assert.deepEqual(parseAllDocuments((await app.inject('/config/export')).body).map((d) => (d.toJS() as Json)['kind']), ['Note'])
    const named = await app.inject('/config/export?kind=Secret&key=s1')
    assert.equal(named.statusCode, 403)
    assert.equal(named.json().error, 'You may not export: Secret (needs the admin role)')
  })

  it('names what a token lacks, and refuses a role that may read nothing', async () => {
    caller = { role: 'admin', apiToken: { scopes: ['secrets:read'] } }
    assert.equal((await app.inject('/config/export')).json().error, 'You may not export: Note (the token needs "notes:read")')
    caller = { role: 'viewer' }
    assert.equal((await app.inject('/config/export')).json().error, 'You may not export: Note (needs the editor role)')
  })

  it('answers 409 when a document cannot be written back', async () => {
    exportFails = true
    const response = await app.inject('/config/export')
    assert.deepEqual([response.statusCode, response.json().error], [409, 'cannot be written back'])
  })
})

describe('import', () => {
  it('validates without writing and applies with the caller recorded', async () => {
    const dry = await post('validate', 'kind: Note\nkey: n2\ntext: second\n')
    assert.deepEqual(dry.json(), { dryRun: true, summary: { create: 1, update: 0, unchanged: 0 }, changes: [{ kind: 'Note', key: 'n2', action: 'create' }] })
    assert.equal(store.Note.has('n2'), false)
    const applied = await post('apply', 'kind: Note\nkey: n2\ntext: second\n---\nkind: Note\nkey: n3\ntext: third\n')
    assert.equal(applied.json().summary.create, 2)
    assert.deepEqual([store.Note.get('n2'), store.Note.get('n3')], ['second', 'third'])
    assert.deepEqual(imports.map((i) => [i.dryRun, i.actor]), [[true, 'actor'], [false, 'actor']])
  })

  it('checks the guard and the media type before the body is read', async () => {
    assert.equal((await post('apply', '{"kind":"Note"}', 'application/json')).statusCode, 415)
    caller = { role: 'guest' }
    assert.equal((await post('apply', 'kind: Note\n')).statusCode, 403)
    caller = { role: 'admin', apiToken: { scopes: ['notes:read'] } }
    const noWrite = await post('apply', 'kind: Note\n')
    assert.equal(noWrite.json().error, 'This token has no permission to import: it needs "notes:write" or "secrets:write"')
  })

  it('refuses empty and unreadable files, and reports problems with their place', async () => {
    assert.deepEqual((await post('apply', '---\n')).json(), { error: 'The file contains no documents' })
    assert.match((await post('apply', 'a: [1')).json().error, /^Invalid YAML: /)
    const invalid = await post('apply', 'kind: Note\nkey: n9\n')
    assert.equal(invalid.statusCode, 400)
    assert.deepEqual(invalid.json().problems, [{ path: 'Note.text', message: 'is required' }])
  })

  it('needs permission for every kind a file holds or links to', async () => {
    caller = { role: 'editor' }
    assert.equal((await post('apply', 'kind: Secret\nkey: x\ntext: t\n')).json().error, 'You may not import: Secret (needs the admin role)')
    assert.equal((await post('apply', 'kind: Note\nkey: x\ntext: t\nlink: true\n')).json().error, 'You may not import: Secret (needs the admin role)')
    caller = { role: 'admin', apiToken: { scopes: ['notes:write'] } }
    assert.equal((await post('apply', 'kind: Secret\nkey: x\ntext: t\n')).json().error, 'You may not import: Secret (the token needs "secrets:write")')
    assert.equal((await post('apply', 'kind: Note\nkey: x\ntext: t\n')).statusCode, 200)
    assert.deepEqual(imports.at(-1)!.scopes, ['notes:write'])
  })

  it('refuses a body over the limit', async () => {
    const big = `kind: Note\nkey: n\ntext: ${'x'.repeat(2 * 1024 * 1024 + 10)}\n`
    assert.equal((await post('apply', big)).statusCode, 413)
  })
})
