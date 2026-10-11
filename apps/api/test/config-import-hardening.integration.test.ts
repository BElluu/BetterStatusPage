import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { sqlite } from '../src/db/client.js'
import { configRoutes } from '../src/routes/config.js'
import type { AuthIdentity } from '../src/services/authSession.js'
import { SECRET_MASK } from '../src/services/secretFields.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-config-import-hardening-')
const app = Fastify({ logger: false })
const anonymous = Fastify({ logger: false })

before(async () => {
  initTestDb()
  app.addHook('onRequest', async (request) => {
    request.user = { userId: 1, email: 'admin@example.test', role: 'admin', sessionId: 'test-session' }
  })
  await app.register(configRoutes, { prefix: '/config' })
  await anonymous.register(configRoutes, { prefix: '/config' })
  await Promise.all([app.ready(), anonymous.ready()])
})

after(async () => {
  await Promise.all([app.close(), anonymous.close()])
  teardownTestDb(testDb)
})

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM monitor_notification_channels; DELETE FROM monitor_dependencies; DELETE FROM monitors;
    DELETE FROM notification_channels; DELETE FROM audit_log;
  `)
})

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const bearer = { authorization: 'Bearer test' }
const post = (path: string, body: unknown, contentType = 'application/yaml', server = app) => server.inject({
  method: 'POST', url: `/config/${path}`,
  headers: { ...bearer, 'content-type': contentType },
  payload: typeof body === 'string' ? body : Array.isArray(body) ? body.map((d) => JSON.stringify(d)).join('\n---\n') : JSON.stringify(body),
})
const apply = (doc: unknown) => post('apply', doc)
const rows = (table: string) => sqlite.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any

const site = (patch: Doc = {}): Doc => ({
  kind: 'Monitor', key: 'site', name: 'Site', type: 'https',
  config: { url: 'https://example.test', method: 'GET', expectedStatus: 200, auth: { type: 'basic', basic: { username: 'svc', password: 'p4ss' } } },
  ...patch,
})
const channel = (patch: Doc = {}): Doc => ({ kind: 'NotificationChannel', key: 'ops', name: 'Ops', type: 'slack', config: { webhookUrl: 'https://hooks.test/secret' }, ...patch })

describe('settings that used to be corrected quietly', () => {
  const problemsFor = async (entry: Doc) => {
    const response = await apply(channel(entry))
    assert.equal(response.statusCode, 400, response.body)
    return Object.fromEntries((response.json().problems as Array<{ path: string; message: string }>).map((p) => [p.path, p.message]))
  }

  it('refuses an alert policy with a misspelled setting, a bad zone or time, or a wrong type', async () => {
    const problems = await problemsFor({
      alertPolicy: {
        quietHours: { enabeld: true, timezone: 'Europe/Warsw', start: '25:99', mode: 'sleep' },
        throttle: { maxAlerts: '3', windowMinutes: 5000 },
        grouping: { minMonitors: 1 },
        digest: {},
      },
    })
    assert.deepEqual(Object.keys(problems).sort(), [
      'NotificationChannel[ops].alertPolicy.digest',
      'NotificationChannel[ops].alertPolicy.grouping.minMonitors',
      'NotificationChannel[ops].alertPolicy.quietHours.enabeld',
      'NotificationChannel[ops].alertPolicy.quietHours.mode',
      'NotificationChannel[ops].alertPolicy.quietHours.start',
      'NotificationChannel[ops].alertPolicy.quietHours.timezone',
      'NotificationChannel[ops].alertPolicy.throttle.maxAlerts',
      'NotificationChannel[ops].alertPolicy.throttle.windowMinutes',
    ])
    assert.equal(problems['NotificationChannel[ops].alertPolicy.digest'], 'is not a known setting')
    assert.equal(problems['NotificationChannel[ops].alertPolicy.throttle.maxAlerts'], 'is not a valid value')
    assert.equal(rows('notification_channels').length, 0)
  })

  it('refuses a policy that is not an object, and accepts a complete valid one exactly as given', async () => {
    assert.equal((await problemsFor({ alertPolicy: 'quiet' }))['NotificationChannel[ops].alertPolicy'], 'must be an object')
    const policy = {
      quietHours: { enabled: true, start: '22:00', end: '07:00', timezone: 'Europe/Warsaw', mode: 'suppress' },
      throttle: { enabled: true, maxAlerts: 5, windowMinutes: 30 },
      grouping: { enabled: true, minMonitors: 4, windowSeconds: 120 },
    }
    assert.equal((await apply(channel({ alertPolicy: policy }))).statusCode, 200)
    assert.deepEqual(JSON.parse(rows('notification_channels')[0]!['alert_policy']), policy)
  })

  it('refuses a threshold that is not a whole number from 1 to 20 instead of clamping it', async () => {
    for (const value of ['3', 50, 0, 2.5, null]) {
      const response = await apply(site({ failureThreshold: value, recoveryThreshold: value }))
      assert.equal(response.statusCode, 400, JSON.stringify(value))
      const paths = response.json().problems.map((p: Doc) => p['path'])
      assert.ok(paths.includes('Monitor[site].failureThreshold') && paths.includes('Monitor[site].recoveryThreshold'), JSON.stringify(value))
    }
    assert.equal((await apply(site({ failureThreshold: 20, recoveryThreshold: 1 }))).statusCode, 200)
    const stored = rows('monitors')[0]!
    assert.deepEqual([stored['failure_threshold'], stored['recovery_threshold']], [20, 1])
  })
})

describe('what a file can do to the parser', () => {
  it('cannot reach the prototype through keys named __proto__ or constructor', async () => {
    const yaml = `kind: Monitor
key: sneaky
name: Sneaky
type: https
config:
  url: https://example.test
  __proto__:
    polluted: true
  constructor:
    prototype:
      polluted: true
  headers:
    __proto__: x
`
    const response = await post('apply', yaml, 'application/yaml')
    // JSON bodies are refused such a name by the parser; a YAML file is refused it here, wherever it is.
    assert.equal(response.statusCode, 400, response.body)
    assert.equal(response.json().problems.length, 1)
    assert.equal(response.json().problems[0].message, '"__proto__" is not allowed as a name')
    assert.match(response.json().problems[0].path, /__proto__$/)
    assert.equal(({} as Doc)['polluted'], undefined)
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false)
    assert.equal(rows('monitors').length, 0)
  })

  it('answers a YAML alias that contains itself with a 400, not a crash', async () => {
    const response = await post('apply', 'kind: Monitor\nconfig: &c\n  url: x\n  again: *c\n', 'application/yaml')
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error, 'Invalid YAML: an alias may not refer to a value that contains it')
    const policy = await post('apply', 'kind: NotificationChannel\nkey: a\nname: A\ntype: slack\nalertPolicy: &p\n  throttle: *p\n', 'application/yaml')
    assert.equal(policy.statusCode, 400)
  })

  it('answers a configuration nested absurdly deep with a 400, not a crash', async () => {
    let deep: Doc = { leaf: true }
    for (let i = 0; i < 5_000; i++) deep = { n: deep }
    const response = await apply([site({ config: { url: 'https://example.test', deep } }), channel({ config: { deep } })])
    assert.equal(response.statusCode, 400)
    // The YAML reader may stop at the depth itself (an `error` only); if it reads it, the import refuses it.
    const { problems, error } = response.json() as { problems?: Doc[]; error: string }
    if (problems) assert.ok(problems.every((p) => /nested deeper than 20 levels/.test(p['message'])), error)
    else assert.match(error, /^Invalid YAML/)
    assert.equal(rows('monitors').length, 0)
  })

  it('does not accept a %YAML directive that would change how the file is read', async () => {
    const response = await post('apply', '%YAML 1.1\n---\nkind: Monitor\n', 'application/yaml')
    assert.equal(response.statusCode, 400)
    assert.match(response.json().error, /directives are not supported/)
  })

  it('refuses a file with too many documents', async () => {
    const response = await post('apply', Array.from({ length: 2_001 }, () => 'a: 1').join('\n---\n'), 'application/yaml')
    assert.equal(response.statusCode, 400)
    assert.match(response.json().error, /^Too many documents/)
  })

  it('does not repeat a megabyte of the file in its answer', async () => {
    const long = 'x'.repeat(100_000)
    const response = await apply(site({ [long]: 1, dependsOn: [long], notifications: [long] }))
    assert.equal(response.statusCode, 400)
    assert.ok(response.body.length < 5_000, `answer is ${response.body.length} bytes`)
    const vault = await apply(site({ config: { url: 'https://a.test', vault: { vault: long, secret: long } } }))
    assert.ok(vault.body.length < 5_000)
    const yaml = await post('apply', `kind: Monitor\n${long}: [\n`, 'application/yaml')
    assert.ok(yaml.body.length < 2_000)
    const kind = await apply({ kind: long })
    assert.ok(kind.body.length < 5_000)
  })
})

describe('types that change in a file', () => {
  it('does not carry a mask from one channel type to another', async () => {
    await apply(channel())
    const response = await apply(channel({ type: 'webhook', config: { url: 'https://x.test', method: 'POST', headers: { 'X-Token': SECRET_MASK } } }))
    assert.equal(response.statusCode, 400)
    assert.match(response.json().problems[0].message, /^headers\.X-Token is a masked placeholder/)
    assert.equal(rows('notification_channels')[0]!['type'], 'slack')
  })

  it('does not carry a mask from an https monitor to a database one', async () => {
    await apply(site())
    const response = await apply({ kind: 'Monitor', key: 'site', name: 'Site', type: 'postgresql', config: { host: 'db', port: 1, database: 'd', user: 'u', password: SECRET_MASK, query: 'select 1' } })
    assert.equal(response.statusCode, 400)
    assert.match(response.json().problems[0].message, /^password is a masked placeholder/)
    assert.equal(rows('monitors')[0]!['type'], 'https')
  })
})

describe('who may send a file', () => {
  it('is checked before the body is read, so a stranger cannot make the server parse a large one', async () => {
    const big = JSON.stringify({ kind: 'Monitor', padding: 'x'.repeat(3 * 1024 * 1024) })
    for (const path of ['validate', 'apply']) {
      const json = await anonymous.inject({ method: 'POST', url: `/config/${path}`, headers: { 'content-type': 'application/json' }, payload: big })
      assert.equal(json.statusCode, 401, `${path} json`)
      const yaml = await anonymous.inject({ method: 'POST', url: `/config/${path}`, headers: { 'content-type': 'application/yaml' }, payload: big })
      assert.equal(yaml.statusCode, 401, `${path} yaml`)
    }
  })
})

// ── what each kind of caller may do with each kind of document ──────────────────────────────────────────────────

describe('permission per kind of document', () => {
  type Caller = { role: string; scopes?: string[] }

  async function as({ role, scopes }: Caller) {
    const server = Fastify({ logger: false })
    server.addHook('onRoute', (route) => { route.config = { ...route.config, allowApiToken: true, tokenScope: 'custom' } })
    server.addHook('onRequest', async (request) => {
      const identity: AuthIdentity = { userId: 1, email: 'caller@example.test', role: role as AuthIdentity['role'], sessionId: scopes ? 'api-token:1' : 'session' }
      if (scopes) identity.apiToken = { id: 1, name: 'ci', scopes }
      request.user = identity
    })
    await server.register(configRoutes, { prefix: '/config' })
    await server.ready()
    return server
  }

  const file = { monitor: site(), channel: channel() }
  const status = async (caller: Caller, documents: unknown, path = 'validate') => {
    const server = await as(caller)
    try { return (await post(path, documents, 'application/yaml', server)).statusCode } finally { await server.close() }
  }
  const exportStatus = async (caller: Caller, query = '') => {
    const server = await as(caller)
    try { return (await server.inject({ url: `/config/export${query}`, headers: bearer })).statusCode } finally { await server.close() }
  }

  it('lets an operator import monitors and channels, and nobody below that anything', async () => {
    assert.deepEqual([await status({ role: 'operator' }, file.monitor), await status({ role: 'operator' }, file.channel)], [200, 200])
    for (const role of ['branding', 'viewer', 'support']) {
      assert.equal(await status({ role }, file.monitor), 403, role)
      assert.equal(await status({ role }, file.channel), 403, role)
    }
  })

  it('refuses a document of any other kind than monitors and channels, as it does not exist', async () => {
    assert.equal(await status({ role: 'operator' }, { kind: 'StatusPageLayout', root: { id: 'root', type: 'page' } }), 400)
  })

  it('lets a token import only the kinds it has the write permission for', async () => {
    const monitors = { role: 'admin', scopes: ['monitors:write'] }
    assert.equal(await status(monitors, file.monitor), 200)
    assert.equal(await status(monitors, file.channel), 403)
    assert.equal(await status({ role: 'admin', scopes: ['monitors:read'] }, file.monitor), 403, 'reading is not enough')
    assert.equal(await status({ role: 'admin', scopes: ['monitors:write', 'channels:write'] }, [file.monitor, file.channel]), 200)
    assert.equal(await status({ role: 'admin', scopes: ['incidents:write'] }, file.monitor), 403)

    const server = await as(monitors)
    const refused = await post('validate', file.channel, 'application/yaml', server)
    await server.close()
    assert.equal(refused.json().error, 'You may not import: NotificationChannel (the token needs "channels:write")')
  })

  it('refuses a token that has no write permission at all before reading the body', async () => {
    assert.equal(await status({ role: 'admin', scopes: ['monitors:read', 'incidents:write'] }, file.monitor), 403)
    assert.equal(await status({ role: 'admin', scopes: ['vault:use'] }, file.monitor, 'apply'), 403)
  })

  it('needs channels:write to change which channels a monitor alerts through', async () => {
    await apply(channel())
    const linked = site({ notifications: ['ops'] })
    const monitorsOnly = await as({ role: 'admin', scopes: ['monitors:write'] })
    const refused = await post('apply', linked, 'application/yaml', monitorsOnly)
    assert.equal(refused.statusCode, 400)
    assert.match(refused.json().problems[0].message, /"channels:write" permission/)
    assert.equal(rows('monitors').length, 0)

    // A monitor that has no channels is fine, and so is leaving the channels it has as they are.
    assert.equal((await post('apply', site(), 'application/yaml', monitorsOnly)).statusCode, 200)
    const both = await as({ role: 'admin', scopes: ['monitors:write', 'channels:write'] })
    assert.equal((await post('apply', linked, 'application/yaml', both)).statusCode, 200)
    assert.equal((await post('apply', { ...linked, intervalSecs: 90 }, 'application/yaml', monitorsOnly)).statusCode, 200)
    const dropped = await post('apply', site({ notifications: [] }), 'application/yaml', monitorsOnly)
    assert.equal(dropped.statusCode, 400, 'removing the links is a change of them too')
    await Promise.all([monitorsOnly.close(), both.close()])
  })

  it('applies the same rules to exporting, with the read permission', async () => {
    assert.equal(await exportStatus({ role: 'admin', scopes: ['monitors:read'] }, '?kind=Monitor&key=nope'), 404, 'allowed, and there is no such monitor')
    assert.equal(await exportStatus({ role: 'admin', scopes: ['monitors:read'] }, '?kind=NotificationChannel&key=x'), 403)
    assert.equal(await exportStatus({ role: 'admin', scopes: ['monitors:read'] }), 403, 'everything needs both')
    assert.equal(await exportStatus({ role: 'admin', scopes: ['monitors:read', 'channels:read'] }), 200)
    assert.equal(await exportStatus({ role: 'admin', scopes: ['monitors:write', 'channels:write'] }), 200, 'writing includes reading')
    assert.equal(await exportStatus({ role: 'branding' }, '?kind=Monitor&key=x'), 403)
    assert.equal(await exportStatus({ role: 'viewer' }), 403)
  })
})
