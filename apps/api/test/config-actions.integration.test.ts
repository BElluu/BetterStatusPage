import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { parseAllDocuments } from 'yaml'
import { db, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { actionRuns, actions, monitorActions, monitors, vaultSecrets, vaults } from '../src/db/schema.js'
import { configRoutes } from '../src/kit/configRoutes.js'
import type { AuthIdentity } from '../src/services/authSession.js'
import { SECRET_MASK } from '../src/services/secretFields.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-config-actions-')
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Caller = { role: string; scopes?: string[] }

before(() => { initTestDb() })
after(() => { teardownTestDb(testDb) })

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM action_runs; DELETE FROM action_failure_channels; DELETE FROM monitor_actions; DELETE FROM actions;
    DELETE FROM monitor_notification_channels; DELETE FROM monitor_dependencies; DELETE FROM monitors;
    DELETE FROM notification_channels; DELETE FROM audit_log; DELETE FROM vault_secrets; DELETE FROM vaults;
  `)
})

async function server({ role, scopes }: Caller) {
  const app = Fastify({ logger: false })
  app.addHook('onRoute', (route) => { route.config = { ...route.config, allowApiToken: true, tokenScope: 'custom' } })
  app.addHook('onRequest', async (request) => {
    const identity: AuthIdentity = { userId: 1, email: 'caller@example.test', role: role as AuthIdentity['role'], sessionId: scopes ? 'api-token:1' : 'session' } as AuthIdentity
    if (scopes) identity.apiToken = { id: 1, name: 'ci', scopes }
    request.user = identity
  })
  await app.register(configRoutes, { prefix: '/config' })
  await app.ready()
  return app
}

async function as<T>(caller: Caller, run: (app: Awaited<ReturnType<typeof server>>) => Promise<T>): Promise<T> {
  const app = await server(caller)
  try { return await run(app) } finally { await app.close() }
}

const admin: Caller = { role: 'admin' }
const bearer = { authorization: 'Bearer test' }
const post = (app: Awaited<ReturnType<typeof server>>, path: string, documents: Doc[]) => app.inject({
  method: 'POST', url: `/config/${path}`, headers: { ...bearer, 'content-type': 'application/yaml' },
  payload: documents.map((d) => JSON.stringify(d)).join('\n---\n'),
})
const apply = (documents: Doc[], caller: Caller = admin) => as(caller, (app) => post(app, 'apply', documents))
const exported = (caller: Caller = admin, query = '') => as(caller, async (app) => {
  const response = await app.inject({ url: `/config/export${query}`, headers: bearer })
  return { status: response.statusCode, documents: response.statusCode === 200 ? parseAllDocuments(response.body).map((d) => d.toJS() as Doc) : [] }
})

// ── documents ───────────────────────────────────────────────────────────────────────────────────────────────────

const channel = (): Doc => ({ kind: 'NotificationChannel', key: 'ops-slack', name: 'Ops Slack', type: 'slack', config: { webhookUrl: 'https://hooks.test/real-secret' } })
const action = (patch: Doc = {}): Doc => ({
  kind: 'Action', key: 'start-vm2', name: 'Start VM2',
  config: { url: 'https://jenkins.test/job/vm2/build', method: 'POST', headers: { Authorization: 'Bearer {{secret_jenkins}}', 'X-Note': 'plain' }, secrets: [{ name: 'jenkins', vault: { vault: 'Jenkins', secret: 'api-token' } }] },
  failureNotifications: ['ops-slack'], ...patch,
})
const monitor = (patch: Doc = {}): Doc => ({
  kind: 'Monitor', key: 'vm1', name: 'VM1 SQL', type: 'sqlserver',
  config: { host: 'vm1.internal', port: 1433, database: 'app', user: 'sa', password: 'pw', query: 'SELECT 1', mode: 'fields' },
  actions: [{ action: 'start-vm2', onStatus: 'down', delayMinutes: 5, cooldownMinutes: 60 }], ...patch,
})
const baseline = (): Doc[] => [channel(), action(), monitor()]

async function vaultWithToken(type: 'value' | 'userpass' = 'value') {
  const now = Date.now()
  const [vault] = await db.insert(vaults).values({ name: 'Jenkins', type: 'local', createdAt: now, updatedAt: now }).returning()
  await db.insert(vaultSecrets).values({ vaultId: vault!.id, name: 'api-token', type, encryptedValue: 'x', createdAt: now, updatedAt: now })
}

const problems = async (documents: Doc[], caller: Caller = admin) => {
  const response = await apply(documents, caller)
  assert.equal(response.statusCode, 400, response.body)
  return (response.json().problems as Array<{ path: string; message: string }>).map((p) => `${p.path}: ${p.message}`)
}

describe('actions in a configuration file', () => {
  it('creates actions, their failure channels and the links of a monitor, and a second apply changes nothing', async () => {
    await vaultWithToken()

    const first = await apply(baseline())
    assert.equal(first.statusCode, 200, first.body)
    assert.deepEqual(first.json().summary, { create: 3, update: 0, unchanged: 0 })

    const [row] = await db.select().from(actions)
    assert.equal(row!.key, 'start-vm2')
    assert.equal(JSON.parse(row!.config).secrets[0].vault.secretId > 0, true)
    const [link] = await db.select().from(monitorActions)
    assert.deepEqual([link!.onStatus, link!.delayMinutes, link!.cooldownMinutes], ['down', 5, 60])

    assert.deepEqual((await apply(baseline())).json().summary, { create: 0, update: 0, unchanged: 3 })
  })

  it('exports them with the secret masked and named, and the export applies back unchanged', async () => {
    await vaultWithToken()
    await apply(baseline())

    const { documents } = await exported()

    assert.deepEqual(documents.map((d) => `${d['kind']}:${d['key']}`), ['NotificationChannel:ops-slack', 'Action:start-vm2', 'Monitor:vm1'])
    const exportedAction = documents[1]!
    assert.deepEqual(exportedAction['config'].secrets, [{ name: 'jenkins', vault: { vault: 'Jenkins', secret: 'api-token' } }])
    assert.equal(exportedAction['config'].headers.Authorization, SECRET_MASK)
    assert.deepEqual(exportedAction['failureNotifications'], ['ops-slack'])
    assert.deepEqual(documents[2]!['actions'], [{ action: 'start-vm2', onStatus: 'down', delayMinutes: 5, cooldownMinutes: 60 }])

    const again = await apply(documents)
    assert.equal(again.statusCode, 200, again.body)
    assert.deepEqual(again.json().summary, { create: 0, update: 0, unchanged: 3 })
  })

  it('reports what changed in a link, and leaves the links of a monitor whose document has no actions field', async () => {
    await vaultWithToken()
    await apply(baseline())

    const changed = await apply([channel(), action(), monitor({ actions: [{ action: 'start-vm2', onStatus: 'down', delayMinutes: 10 }] })])
    assert.deepEqual(changed.json().changes.find((c: Doc) => c.kind === 'Monitor').fields, ['actions'])

    const { actions: _omitted, ...withoutActions } = monitor()
    assert.deepEqual((await apply([channel(), action(), withoutActions])).json().summary, { create: 0, update: 0, unchanged: 3 })
    assert.equal((await db.select().from(monitorActions)).length, 1)
  })

  it('removes the links with an empty list and cancels the runs that were waiting for them', async () => {
    await vaultWithToken()
    await apply(baseline())
    const [m] = await db.select().from(monitors)
    const [a] = await db.select().from(actions)
    const now = Date.now()
    await db.insert(actionRuns).values({ actionId: a!.id, actionName: 'Start VM2', monitorId: m!.id, monitorName: 'VM1 SQL', onStatus: 'down', variables: '{}', nextAttemptAt: now + 60_000, createdAt: now, updatedAt: now })

    await apply([channel(), action(), monitor({ actions: [] })])

    assert.equal((await db.select().from(monitorActions)).length, 0)
    assert.equal((await db.select().from(actionRuns))[0]!.status, 'cancelled')
  })

  it('keeps a stored secret header when the file sends the mask back, and refuses a mask with no secret behind it', async () => {
    await vaultWithToken()
    await apply([channel(), action({ config: { url: 'https://jenkins.test/build', method: 'POST', headers: { 'X-Api-Key': 'real-key-1234' } } })])

    const kept = await apply([channel(), action({ config: { url: 'https://jenkins.test/build', method: 'POST', headers: { 'X-Api-Key': SECRET_MASK } } })])
    assert.equal(kept.statusCode, 200, kept.body)
    assert.equal(JSON.parse((await db.select().from(actions))[0]!.config).headers['X-Api-Key'], 'real-key-1234')

    await db.delete(actions)
    assert.equal((await problems([channel(), action({ config: { url: 'https://jenkins.test/build', method: 'POST', headers: { 'X-Api-Key': SECRET_MASK } } })])).length > 0, true)
  })

  it('names every problem with its place, the shape of a document before what it refers to', async () => {
    await vaultWithToken()
    const shape = (await problems([
      channel(),
      monitor({ actions: [{ action: 'start-vm2', onStatus: 'sideways' }, { action: 'start-vm2', onStatus: 'up', delayMinutes: -1 }] }),
      monitor({ key: 'dup', actions: [{ action: 'start-vm2', onStatus: 'up' }, { action: 'start-vm2', onStatus: 'up' }] }),
    ])).join('\n')
    assert.match(shape, /Monitor\[vm1\]\.actions\[0\]\.onStatus: must be one of: down, up/)
    assert.match(shape, /Monitor\[vm1\]\.actions\[1\]\.delayMinutes: must be a whole number/)
    assert.match(shape, /Monitor\[dup\]\.actions\[1\]: an action can be linked once per status/)

    const references = (await problems([
      channel(),
      action({ key: 'bad-url', config: { url: 'ftp://x', method: 'POST' }, failureNotifications: ['nope'] }),
      action({ key: 'no-vault', config: { url: 'https://x.test', method: 'POST', headers: { A: '{{secret_jenkins}}' } }, failureNotifications: [] }),
      action({ key: 'wrong-secret', config: { url: 'https://x.test', method: 'POST', headers: { A: '{{secret_jenkins_basic}}' }, secrets: [{ name: 'jenkins', vault: { vault: 'Jenkins', secret: 'api-token' } }] }, failureNotifications: [] }),
      action({ key: 'unknown-vault', config: { url: 'https://x.test', method: 'POST', headers: { A: '{{secret_jenkins}}' }, secrets: [{ name: 'jenkins', vault: { vault: 'Nope', secret: 'x' } }] }, failureNotifications: [] }),
      monitor({ actions: [{ action: 'missing', onStatus: 'down' }] }),
    ])).join('\n')
    assert.match(references, /Action\[bad-url\]\.config: url must start with/)
    assert.match(references, /Action\[bad-url\]\.failureNotifications: unknown channel "nope"/)
    assert.match(references, /Action\[no-vault\]\.config: \{\{secret_jenkins\}\} refers to a secret named "jenkins"/)
    assert.match(references, /Action\[wrong-secret\]\.config: \{\{secret_jenkins_basic\}\} is not available from the single-value secret "jenkins"/)
    assert.match(references, /Action\[unknown-vault\]\.config\.secrets\[0\]\.vault: unknown vault "Nope"/)
    assert.match(references, /Monitor\[vm1\]\.actions: unknown action "missing"/)
    assert.equal((await db.select().from(actions)).length, 0, 'nothing is written when anything is wrong')
  })
})

describe('who may use actions in a file', () => {
  const operator: Caller = { role: 'operator' }

  it('leaves actions out of the full export of an operator, and refuses to export one', async () => {
    await vaultWithToken()
    await apply(baseline())

    const { status, documents } = await exported(operator)
    assert.equal(status, 200)
    assert.deepEqual(documents.map((d) => d['kind']), ['NotificationChannel', 'Monitor'])
    assert.equal('actions' in documents[1]!, false)
    assert.equal((await exported(operator, '?kind=Action&key=start-vm2')).status, 403)
  })

  it('refuses an operator an Action document, and a monitor that carries an actions list', async () => {
    await vaultWithToken()
    assert.equal((await apply([channel(), action()], operator)).statusCode, 403)
    assert.equal((await apply([monitor()], operator)).statusCode, 403)

    const { actions: _omitted, ...withoutActions } = monitor()
    assert.equal((await apply([withoutActions], operator)).statusCode, 200)
  })

  it('does not break the full export of a token that predates actions, and includes them for one that may read them', async () => {
    await vaultWithToken()
    await apply(baseline())

    const old = await exported({ role: 'operator', scopes: ['monitors:read', 'channels:read'] })
    assert.deepEqual(old.documents.map((d) => d['kind']), ['NotificationChannel', 'Monitor'])

    const full = await exported({ role: 'operator', scopes: ['monitors:read', 'channels:read', 'actions:read'] })
    assert.deepEqual(full.documents.map((d) => d['kind']), ['NotificationChannel', 'Action', 'Monitor'])
    assert.equal((await exported({ role: 'operator', scopes: ['monitors:read'] }, '?kind=Action&key=start-vm2')).status, 403)
  })

  it('needs actions:write for an Action, channels:write to choose its failure channels, and vault:use for a vault reference', async () => {
    await vaultWithToken()
    await apply([channel()])
    const documents = [action()]

    const noVault = await apply(documents, { role: 'operator', scopes: ['actions:write', 'channels:write'] })
    assert.equal(noVault.statusCode, 400)
    assert.match(JSON.stringify(noVault.json().problems), /vault:use/)

    const noChannels = await apply(documents, { role: 'operator', scopes: ['actions:write', 'vault:use'] })
    assert.equal(noChannels.statusCode, 400)
    assert.match(JSON.stringify(noChannels.json().problems), /channels:write/)

    assert.equal((await apply(documents, { role: 'operator', scopes: ['monitors:write'] })).statusCode, 403)
    assert.equal((await apply(documents, { role: 'operator', scopes: ['actions:write', 'channels:write', 'vault:use'] })).statusCode, 200)
  })
})

describe('upgrading a database whose actions have no key', () => {
  it('gives each existing action a key from its name, in id order, and a unique index', () => {
    sqlite.exec(`DROP INDEX idx_actions_key; ALTER TABLE actions DROP COLUMN key; DELETE FROM schema_migrations WHERE name = 'action-keys-backfill-v1';`)
    const now = Date.now()
    const insert = sqlite.prepare("INSERT INTO actions (name, config, enabled, created_at, updated_at) VALUES (?, '{}', 1, ?, ?)")
    for (const name of ['Start VM2', 'Start VM2', 'Zażółć gęślą']) insert.run(name, now, now)

    runMigrations()

    const keys = (sqlite.prepare('SELECT key FROM actions ORDER BY id').all() as Array<{ key: string }>).map((row) => row.key)
    assert.deepEqual(keys, ['start-vm2', 'start-vm2-2', 'zazolc-gesla'])
    assert.throws(() => sqlite.prepare("INSERT INTO actions (name, config, enabled, created_at, updated_at, key) VALUES ('x', '{}', 1, 1, 1, 'start-vm2')").run())
  })
})
