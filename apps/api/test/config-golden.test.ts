import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { db } from '../src/db/client.js'
import { vaultSecrets, vaults } from '../src/db/schema.js'
import { configRoutes } from '../src/routes/config.js'
import type { AuthIdentity } from '../src/services/authSession.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

// Guards the extraction of the configuration engine: the YAML written for every kind of document, the answers of the
// import (plan and apply) and of the refusals must not change by a byte. Regenerate on purpose with UPDATE_SNAPSHOTS=1.
const GOLDEN = fileURLToPath(new URL('./fixtures/config-golden.json', import.meta.url))

const testDb = createTestDb('bsp-config-golden-')
type Doc = Record<string, unknown>
type Caller = { role: string; scopes?: string[] }

before(() => { initTestDb() })
after(() => { teardownTestDb(testDb) })

async function server({ role, scopes }: Caller) {
  const app = Fastify({ logger: false })
  app.addHook('onRoute', (route) => { route.config = { ...route.config, allowApiToken: true, tokenScope: 'custom' } })
  app.addHook('onRequest', async (request) => {
    const identity = { userId: 1, email: 'caller@example.test', role, sessionId: scopes ? 'api-token:1' : 'session' } as AuthIdentity
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
const answer = (response: { statusCode: number; headers: Record<string, unknown>; body: string }) => ({
  status: response.statusCode, type: response.headers['content-type'] ?? null, body: response.body,
})
const send = (caller: Caller, path: string, body: string, type = 'application/yaml') => as(caller, async (app) => answer(await app.inject({
  method: 'POST', url: `/config/${path}`, headers: { authorization: 'Bearer test', 'content-type': type }, payload: body,
})))
const get = (caller: Caller, url: string) => as(caller, async (app) => answer(await app.inject({ url: `/config/${url}` })))
const documents = (docs: Doc[]) => docs.map((doc) => JSON.stringify(doc)).join('\n---\n')

const channels: Doc[] = [
  { kind: 'NotificationChannel', key: 'ops-slack', name: 'Ops Slack', type: 'slack', notifyOnRecovery: true, config: { webhookUrl: 'https://hooks.slack.test/T0/B0/secretpart', text: 'Down: {{monitor_name}}' } },
  { kind: 'NotificationChannel', key: 'tg', name: 'Telegram bot', type: 'telegram', enabled: false, config: { chatId: '-100500', vault: { vault: 'Production', secret: 'bot-token' } },
    alertPolicy: { quietHours: { enabled: true, start: '22:00', end: '07:00', timezone: 'Europe/Warsaw', mode: 'suppress' }, throttle: { enabled: true, maxAlerts: 3, windowMinutes: 30 } } },
]
const actions: Doc[] = [
  { kind: 'Action', key: 'start-vm2', name: 'Start VM2', failureNotifications: ['ops-slack'],
    config: { url: 'https://jenkins.test/job/vm2/build', method: 'POST', headers: { Authorization: 'Bearer {{secret_jenkins}}', 'X-Note': 'plain' }, secrets: [{ name: 'jenkins', vault: { vault: 'Jenkins', secret: 'api-token' } }] } },
]
const monitors: Doc[] = [
  { kind: 'Monitor', key: 'public-site', name: 'Public site', type: 'https', intervalSecs: 30, tags: [{ label: 'prod', color: '#00ff00' }], notifications: ['tg', 'ops-slack'], dependsOn: ['billing-db'],
    config: { url: 'https://example.test', method: 'GET', expectedStatus: 200, headers: { Authorization: 'Bearer plaintext-token', Accept: 'application/json' }, auth: { type: 'basic', basic: { username: 'svc', password: 'plaintext-pass' } } } },
  { kind: 'Monitor', key: 'billing-db', name: 'Billing DB', type: 'postgresql', config: { host: 'db.internal', port: 5432, database: 'billing', user: 'app', password: 'db-pass', query: 'select 1', mode: 'fields' } },
  { kind: 'Monitor', key: 'nightly-job', name: 'Nightly job', type: 'webhook', config: {} },
  { kind: 'Monitor', key: 'vm1', name: 'VM1 SQL', type: 'sqlserver', autoIncident: { afterMinutes: 5, mode: 'draft' },
    config: { host: 'vm1.internal', port: 1433, database: 'app', user: 'sa', password: 'pw', query: 'SELECT 1', mode: 'fields' },
    actions: [{ action: 'start-vm2', onStatus: 'down', delayMinutes: 5, cooldownMinutes: 60 }] },
]
const everything = [...channels, ...actions, ...monitors]

const invalid: Array<[string, Doc[]]> = [
  ['unknown kind', [{ kind: 'Nope', key: 'x' }]],
  ['missing kind', [{ key: 'x' }]],
  ['duplicate key', [{ kind: 'Monitor', key: 'a', name: 'A', type: 'webhook', config: {} }, { kind: 'Monitor', key: 'a', name: 'B', type: 'webhook', config: {} }]],
  ['bad key and unknown field', [{ kind: 'NotificationChannel', key: 'Bad Key', name: 'X', type: 'slack', config: {}, surprise: 1 }]],
  ['bad values', [{ kind: 'Monitor', key: 'm', name: 'M', type: 'https', intervalSecs: 5, timeout: 10, config: 'url', tags: 'x' }]],
  ['unknown reference', [{ kind: 'Monitor', key: 'm', name: 'M', type: 'webhook', config: {}, notifications: ['ghost'], dependsOn: ['ghost'] }]],
  ['dependency cycle', [
    { kind: 'Monitor', key: 'a', name: 'A', type: 'webhook', config: {}, dependsOn: ['b'] },
    { kind: 'Monitor', key: 'b', name: 'B', type: 'webhook', config: {}, dependsOn: ['a'] }]],
]

describe('configuration output', () => {
  it('matches the recorded YAML, answers and refusals', async () => {
    const now = Date.now()
    for (const name of ['Production', 'Jenkins']) {
      const [vault] = await db.insert(vaults).values({ name, type: 'local', createdAt: now, updatedAt: now }).returning()
      const secrets = name === 'Production' ? [['bot-token', 'value'], ['db-login', 'userpass']] : [['api-token', 'value']]
      for (const [secret, type] of secrets) {
        await db.insert(vaultSecrets).values({ vaultId: vault!.id, name: secret!, type: type!, encryptedValue: 'x', createdAt: now, updatedAt: now })
      }
    }

    const output: Record<string, unknown> = {}
    output['validate-before'] = await send(admin, 'validate', documents(everything))
    output['apply'] = await send(admin, 'apply', documents(everything))
    output['apply-again'] = await send(admin, 'apply', documents(everything))
    output['export-all'] = await get(admin, 'export')
    output['export-one'] = {
      channel: await get(admin, 'export?kind=NotificationChannel&key=tg'),
      action: await get(admin, 'export?kind=Action&key=start-vm2'),
      monitor: await get(admin, 'export?kind=Monitor&key=public-site'),
      monitorWithActions: await get(admin, 'export?kind=Monitor&key=vm1'),
    }
    const exported = (output['export-all'] as { body: string }).body
    output['reapply-export'] = await send(admin, 'apply', exported)
    output['changed'] = await send(admin, 'apply', documents([{ ...monitors[2], name: 'Nightly job renamed' }]))

    const problems: Record<string, unknown> = {}
    for (const [name, docs] of invalid) problems[name] = await send(admin, 'validate', documents(docs))
    output['problems'] = problems

    output['refusals'] = {
      jsonBody: await send(admin, 'apply', '{"kind":"Monitor"}', 'application/json'),
      emptyFile: await send(admin, 'apply', '---\n'),
      notYaml: await send(admin, 'apply', 'a: [1'),
      directive: await send(admin, 'apply', '%YAML 1.1\n---\nkind: Monitor\n'),
      viewer: await send({ role: 'viewer' }, 'apply', documents(monitors)),
      operatorAction: await send({ role: 'operator' }, 'apply', documents(actions)),
      tokenNoScope: await send({ role: 'admin', scopes: ['monitors:read'] }, 'apply', documents(monitors)),
      tokenOneKind: await send({ role: 'admin', scopes: ['channels:write'] }, 'apply', documents(monitors)),
      exportBadKind: await get(admin, 'export?kind=Nope&key=x'),
      exportNoKey: await get(admin, 'export?kind=Monitor'),
      exportMissing: await get(admin, 'export?kind=Monitor&key=ghost'),
      exportOperatorNoActions: await get({ role: 'operator' }, 'export'),
      exportOperatorAction: await get({ role: 'operator' }, 'export?kind=Action&key=start-vm2'),
      exportTokenNoRead: await get({ role: 'admin', scopes: ['monitors:read'] }, 'export'),
    }

    const actual = JSON.stringify(output, null, 2) + '\n'
    if (process.env['UPDATE_SNAPSHOTS'] === '1' || !existsSync(GOLDEN)) {
      mkdirSync(dirname(GOLDEN), { recursive: true })
      writeFileSync(GOLDEN, actual)
    }
    assert.equal(actual, readFileSync(GOLDEN, 'utf8').replace(/\r\n/g, '\n'))
  })
})
