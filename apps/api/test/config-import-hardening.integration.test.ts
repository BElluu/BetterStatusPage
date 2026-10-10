import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { sqlite } from '../src/db/client.js'
import { configRoutes } from '../src/routes/config.js'
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
    DELETE FROM incident_monitors; DELETE FROM incidents; DELETE FROM maintenance_window_monitors; DELETE FROM maintenance_windows;
    DELETE FROM monitor_notification_channels; DELETE FROM monitor_dependencies; DELETE FROM monitors;
    DELETE FROM notification_channels; DELETE FROM layout; DELETE FROM audit_log;
  `)
})

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const bearer = { authorization: 'Bearer test' }
const post = (path: string, body: unknown, query = '', contentType = 'application/json') => app.inject({
  method: 'POST', url: `/config/${path}${query}`,
  headers: { ...bearer, 'content-type': contentType },
  payload: typeof body === 'string' ? body : JSON.stringify(body),
})
const apply = (doc: unknown, query = '') => post('apply', doc, query)
const rows = (table: string) => sqlite.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any

const site = (patch: Doc = {}): Doc => ({
  key: 'site', name: 'Site', type: 'https',
  config: { url: 'https://example.test', method: 'GET', expectedStatus: 200, auth: { type: 'basic', basic: { username: 'svc', password: 'p4ss' } } },
  ...patch,
})
const channel = (patch: Doc = {}): Doc => ({ key: 'ops', name: 'Ops', type: 'slack', config: { webhookUrl: 'https://hooks.test/secret' }, ...patch })

describe('settings that used to be corrected quietly', () => {
  const problemsFor = async (entry: Doc) => {
    const response = await apply({ version: 1, channels: [channel(entry)] })
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
      'channels[ops].alertPolicy.digest',
      'channels[ops].alertPolicy.grouping.minMonitors',
      'channels[ops].alertPolicy.quietHours.enabeld',
      'channels[ops].alertPolicy.quietHours.mode',
      'channels[ops].alertPolicy.quietHours.start',
      'channels[ops].alertPolicy.quietHours.timezone',
      'channels[ops].alertPolicy.throttle.maxAlerts',
      'channels[ops].alertPolicy.throttle.windowMinutes',
    ])
    assert.equal(problems['channels[ops].alertPolicy.digest'], 'is not a known setting')
    assert.equal(problems['channels[ops].alertPolicy.throttle.maxAlerts'], 'is not a valid value')
    assert.equal(rows('notification_channels').length, 0)
  })

  it('refuses a policy that is not an object, and accepts a complete valid one exactly as given', async () => {
    assert.equal((await problemsFor({ alertPolicy: 'quiet' }))['channels[ops].alertPolicy'], 'must be an object')
    const policy = {
      quietHours: { enabled: true, start: '22:00', end: '07:00', timezone: 'Europe/Warsaw', mode: 'suppress' },
      throttle: { enabled: true, maxAlerts: 5, windowMinutes: 30 },
      grouping: { enabled: true, minMonitors: 4, windowSeconds: 120 },
    }
    assert.equal((await apply({ version: 1, channels: [channel({ alertPolicy: policy })] })).statusCode, 200)
    assert.deepEqual(JSON.parse(rows('notification_channels')[0]!['alert_policy']), policy)
  })

  it('refuses a threshold that is not a whole number from 1 to 20 instead of clamping it', async () => {
    for (const value of ['3', 50, 0, 2.5, null]) {
      const response = await apply({ version: 1, monitors: [site({ failureThreshold: value, recoveryThreshold: value })] })
      assert.equal(response.statusCode, 400, JSON.stringify(value))
      const paths = response.json().problems.map((p: Doc) => p['path'])
      assert.ok(paths.includes('monitors[site].failureThreshold') && paths.includes('monitors[site].recoveryThreshold'), JSON.stringify(value))
    }
    assert.equal((await apply({ version: 1, monitors: [site({ failureThreshold: 20, recoveryThreshold: 1 })] })).statusCode, 200)
    const stored = rows('monitors')[0]!
    assert.deepEqual([stored['failure_threshold'], stored['recovery_threshold']], [20, 1])
  })
})

describe('pruning an empty section', () => {
  beforeEach(async () => {
    assert.equal((await apply({ version: 1, channels: [channel()], monitors: [site()] })).statusCode, 200)
  })

  it('is refused, because it would remove everything', async () => {
    for (const section of ['monitors', 'channels']) {
      const response = await apply({ version: 1, [section]: [] }, '?prune=true')
      assert.equal(response.statusCode, 400, section)
      assert.match(response.json().problems[0].message, new RegExp(`^is empty, so pruning would remove every one of the 1 ${section}`))
    }
    assert.equal(rows('monitors').length, 1)
    assert.equal(rows('notification_channels').length, 1)
  })

  it('is allowed when asked for, and an empty section without prune does nothing', async () => {
    assert.equal((await apply({ version: 1, monitors: [] })).json().summary.delete, 0)
    assert.equal(rows('monitors').length, 1)

    const dryRun = await post('validate', { version: 1, monitors: [] }, '?prune=true&allowEmpty=true')
    assert.deepEqual(dryRun.json().summary, { create: 0, update: 0, unchanged: 0, delete: 1 })
    const response = await apply({ version: 1, monitors: [] }, '?prune=true&allowEmpty=true')
    assert.equal(response.json().summary.delete, 1)
    assert.equal(rows('monitors').length, 0)
  })

  it('does not stop a prune that replaces everything with other monitors, or one on an installation with nothing to remove', async () => {
    assert.equal((await apply({ version: 1, monitors: [site({ key: 'other' })] }, '?prune=true')).json().summary.delete, 1)
    sqlite.exec('DELETE FROM monitors')
    assert.equal((await apply({ version: 1, monitors: [] }, '?prune=true')).statusCode, 200)
  })

  it('refuses anything but true or false for allowEmpty', async () => {
    assert.equal((await apply({ version: 1 }, '?allowEmpty=1')).statusCode, 400)
  })
})

describe('pruning monitors that other things refer to', () => {
  it('takes their nodes out of a layout the file does not describe, also inside groups', async () => {
    assert.equal((await apply({
      version: 1,
      monitors: [site(), site({ key: 'keep', name: 'Keep' })],
      layout: { id: 'root', type: 'page', children: [
        { id: 'g', type: 'group', label: 'Core', collapsible: true, children: [
          { id: 'm1', type: 'monitor', monitorKey: 'site' },
          { id: 'm2', type: 'monitor', monitorKey: 'keep' },
        ] },
        { id: 'c1', type: 'chart', monitorKey: 'site' },
        { id: 't', type: 'text', text: 'Hi' },
      ] },
    })).statusCode, 200)

    const response = await apply({ version: 1, monitors: [site({ key: 'keep', name: 'Keep' })] }, '?prune=true')
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json().changes.find((c: Doc) => c['kind'] === 'layout'), { kind: 'layout', action: 'update', fields: ['nodes of removed monitors'] })
    const tree = JSON.parse(rows('layout')[0]!['tree'])
    assert.deepEqual(tree.children.map((n: Doc) => n['id']), ['g', 't'])
    assert.deepEqual(tree.children[0].children.map((n: Doc) => n['id']), ['m2'])
    assert.ok(rows('audit_log').some((e) => e['entity_type'] === 'layout' && /nodes of removed monitors/.test(e['diff'])))
  })

  it('leaves a layout alone when it shows none of the removed monitors', async () => {
    await apply({ version: 1, monitors: [site(), site({ key: 'keep', name: 'Keep' })], layout: { id: 'root', type: 'page', children: [{ id: 'm', type: 'monitor', monitorKey: 'keep' }] } })
    const response = await apply({ version: 1, monitors: [site({ key: 'keep', name: 'Keep' })] }, '?prune=true')
    assert.deepEqual(response.json().summary, { create: 0, update: 0, unchanged: 1, delete: 1 })
  })

  it('removes the incident and maintenance links of a removed monitor, which have no foreign key', async () => {
    await apply({ version: 1, monitors: [site(), site({ key: 'keep', name: 'Keep' })] })
    const id = (key: string) => (sqlite.prepare('SELECT id FROM monitors WHERE key = ?').get(key) as { id: number }).id
    const now = Date.now()
    const incident = Number(sqlite.prepare('INSERT INTO incidents (title, started_at, created_at, updated_at) VALUES (?, ?, ?, ?)').run('Outage', now, now, now).lastInsertRowid)
    const window = Number(sqlite.prepare('INSERT INTO maintenance_windows (name, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('Upgrade', now, now + 1000, now, now).lastInsertRowid)
    for (const key of ['site', 'keep']) {
      sqlite.prepare('INSERT INTO incident_monitors (incident_id, monitor_id) VALUES (?, ?)').run(incident, id(key))
      sqlite.prepare('INSERT INTO maintenance_window_monitors (window_id, monitor_id) VALUES (?, ?)').run(window, id(key))
    }
    await apply({ version: 1, monitors: [site({ key: 'keep', name: 'Keep' })] }, '?prune=true')
    assert.deepEqual(rows('incident_monitors').map((r) => r['monitor_id']), [id('keep')])
    assert.deepEqual(rows('maintenance_window_monitors').map((r) => r['monitor_id']), [id('keep')])
  })
})

describe('what a file can do to the parser', () => {
  it('cannot reach the prototype through keys named __proto__ or constructor', async () => {
    const yaml = `version: 1
monitors:
  - key: sneaky
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
    const response = await post('apply', yaml, '', 'application/yaml')
    assert.ok([200, 400].includes(response.statusCode), response.body)
    assert.equal(({} as Doc)['polluted'], undefined)
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false)
  })

  it('answers a configuration nested absurdly deep with a 400, not a crash', async () => {
    let deep: Doc = { leaf: true }
    for (let i = 0; i < 5_000; i++) deep = { n: deep }
    const response = await apply({ version: 1, monitors: [site({ config: { url: 'https://example.test', deep } })], channels: [channel({ config: { deep } })] })
    assert.equal(response.statusCode, 400)
    const messages = response.json().problems.map((p: Doc) => p['message'])
    assert.ok(messages.every((m: string) => /nested deeper than 20 levels/.test(m)), messages.join())
    assert.equal(rows('monitors').length, 0)
  })

  it('does not accept a %YAML directive that would change how the file is read', async () => {
    const response = await post('apply', '%YAML 1.1\n---\nversion: 1\n', '', 'application/yaml')
    assert.equal(response.statusCode, 400)
    assert.match(response.json().error, /directives are not supported/)
  })

  it('does not repeat a megabyte of the file in its answer', async () => {
    const long = 'x'.repeat(100_000)
    const response = await apply({ version: 1, monitors: [site({ [long]: 1, dependsOn: [long], notifications: [long] })] })
    assert.equal(response.statusCode, 400)
    assert.ok(response.body.length < 5_000, `answer is ${response.body.length} bytes`)
    const vault = await apply({ version: 1, monitors: [site({ config: { url: 'https://a.test', vault: { vault: long, secret: long } } })] })
    assert.ok(vault.body.length < 5_000)
    const yaml = await post('apply', `version: 1\n${long}: [\n`, '', 'application/yaml')
    assert.ok(yaml.body.length < 2_000)
  })
})

describe('types that change in a file', () => {
  it('does not carry a mask from one channel type to another', async () => {
    await apply({ version: 1, channels: [channel()] })
    const response = await apply({ version: 1, channels: [channel({ type: 'webhook', config: { url: 'https://x.test', method: 'POST', headers: { 'X-Token': SECRET_MASK } } })] })
    assert.equal(response.statusCode, 400)
    assert.match(response.json().problems[0].message, /^headers\.X-Token is a masked placeholder/)
    assert.equal(rows('notification_channels')[0]!['type'], 'slack')
  })

  it('does not carry a mask from a webhook monitor to an https one, or from one type of check to another', async () => {
    await apply({ version: 1, monitors: [site()] })
    const response = await apply({
      version: 1,
      monitors: [{ key: 'site', name: 'Site', type: 'postgresql', config: { host: 'db', port: 1, database: 'd', user: 'u', password: SECRET_MASK, query: 'select 1' } }],
    })
    assert.equal(response.statusCode, 400)
    assert.match(response.json().problems[0].message, /^password is a masked placeholder/)
    assert.equal(rows('monitors')[0]!['type'], 'https')
  })
})

describe('who may send a file', () => {
  it('is checked before the body is read, so a stranger cannot make the server parse a large one', async () => {
    const big = JSON.stringify({ version: 1, padding: 'x'.repeat(3 * 1024 * 1024) })
    for (const path of ['validate', 'apply']) {
      const json = await anonymous.inject({ method: 'POST', url: `/config/${path}`, headers: { 'content-type': 'application/json' }, payload: big })
      assert.equal(json.statusCode, 401, `${path} json`)
      const yaml = await anonymous.inject({ method: 'POST', url: `/config/${path}`, headers: { 'content-type': 'application/yaml' }, payload: big })
      assert.equal(yaml.statusCode, 401, `${path} yaml`)
    }
  })
})
