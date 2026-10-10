import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { parseAllDocuments, stringify } from 'yaml'
import { db, sqlite } from '../src/db/client.js'
import { vaultSecrets, vaults } from '../src/db/schema.js'
import { configRoutes } from '../src/routes/config.js'
import { SECRET_MASK } from '../src/services/secretFields.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-config-import-')
const app = Fastify({ logger: false })

before(async () => {
  initTestDb()
  // How the admin API reaches a handler: a token is allowed here and checked by the handler itself.
  app.addHook('onRoute', (route) => { route.config = { ...route.config, allowApiToken: true, tokenScope: 'custom' } })
  app.addHook('onRequest', async (request) => {
    request.user = { userId: 1, email: 'admin@example.test', role: 'admin', sessionId: 'test-session' }
  })
  await app.register(configRoutes, { prefix: '/config' })
  await app.ready()
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM monitor_notification_channels; DELETE FROM monitor_dependencies; DELETE FROM monitors;
    DELETE FROM notification_channels; DELETE FROM audit_log;
    DELETE FROM vault_secrets; DELETE FROM vaults;
  `)
})

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const channel = (patch: Doc = {}): Doc => ({ kind: 'NotificationChannel', key: 'ops-slack', name: 'Ops Slack', type: 'slack', notifyOnRecovery: true, config: { webhookUrl: 'https://hooks.test/real-secret' }, ...patch })
const pager = (): Doc => ({ kind: 'NotificationChannel', key: 'pager', name: 'Pager', type: 'webhook', enabled: false, config: { url: 'https://pager.test/hook', method: 'POST', headers: { Authorization: 'Bearer pager-secret' } } })
const database = (patch: Doc = {}): Doc => ({ kind: 'Monitor', key: 'billing-db', name: 'Billing DB', type: 'postgresql', config: { host: 'db.internal', port: 5432, database: 'billing', user: 'app', password: 'db-secret', query: 'select 1', mode: 'fields' }, ...patch })
const site = (patch: Doc = {}): Doc => ({
  kind: 'Monitor', key: 'public-site', name: 'Public site', type: 'https', intervalSecs: 30, tags: [{ label: 'prod', color: '#00ff00' }],
  config: { url: 'https://example.test', method: 'GET', expectedStatus: 200, auth: { type: 'basic', basic: { username: 'svc', password: 'p4ss' } } },
  notifications: ['ops-slack', 'pager'], dependsOn: ['billing-db'], ...patch,
})
const heartbeat = (): Doc => ({ kind: 'Monitor', key: 'nightly-job', name: 'Nightly job', type: 'webhook', config: {} })
/** Two channels and three monitors that refer to each other. */
const baseline = (): Doc[] => [channel(), pager(), database(), site(), heartbeat()]

// A Bearer header is how an API token calls this, and it is what lets the request skip the CSRF check a browser needs.
const bearer = { authorization: 'Bearer test' }
const post = (path: string, payload: unknown, contentType = 'application/yaml') => app.inject({
  method: 'POST', url: `/config/${path}`,
  headers: { ...bearer, 'content-type': contentType },
  // JSON is YAML, and a list is a stream of documents.
  payload: typeof payload === 'string' ? payload : Array.isArray(payload) ? payload.map((d) => JSON.stringify(d)).join('\n---\n') : JSON.stringify(payload),
})
const apply = (documents: unknown) => post('apply', documents)
const validate = (documents: unknown) => post('validate', documents)
const exported = async () => parseAllDocuments((await app.inject({ url: '/config/export', headers: bearer })).body).map((document) => document.toJS() as Doc)

async function applied(documents: unknown): Promise<Doc> {
  const response = await apply(documents)
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}

const rows = (table: string) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all() as Array<Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any
const stored = (key: string) => JSON.parse((sqlite.prepare('SELECT config FROM monitors WHERE key = ?').get(key) as { config: string }).config)
const everything = () => JSON.stringify(['monitors', 'notification_channels', 'monitor_notification_channels', 'monitor_dependencies'].map(rows))
const change = (result: Doc, kind: string, key?: string) => result['changes'].find((c: Doc) => c['kind'] === kind && c['key'] === key)

// ── creating ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('importing into an empty installation', () => {
  it('creates channels, monitors and their links', async () => {
    const result = await applied(baseline())
    assert.deepEqual(result['summary'], { create: 5, update: 0, unchanged: 0 })
    assert.equal(result['dryRun'], false)

    const row = rows('monitors').find((m) => m['key'] === 'public-site')!
    assert.deepEqual([row['name'], row['type'], row['interval_secs'], row['current_status']], ['Public site', 'https', 30, 'pending'])
    assert.deepEqual(JSON.parse(row['tags']), [{ label: 'prod', color: '#00ff00' }])
    assert.equal(stored('public-site').auth.basic.password, 'p4ss', 'secrets are stored as given')

    const keyOf = (table: string, id: number) => (sqlite.prepare(`SELECT key FROM ${table} WHERE id = ?`).get(id) as { key: string }).key
    assert.deepEqual(rows('monitor_notification_channels').map((l) => [keyOf('monitors', l['monitor_id']), keyOf('notification_channels', l['channel_id'])]).sort(),
      [['public-site', 'ops-slack'], ['public-site', 'pager']])
    assert.deepEqual(rows('monitor_dependencies').map((d) => [keyOf('monitors', d['dependent_id']), keyOf('monitors', d['depends_on_id'])]), [['public-site', 'billing-db']])

    const pagerRow = rows('notification_channels').find((c) => c['key'] === 'pager')!
    assert.deepEqual([pagerRow['enabled'], pagerRow['notify_on_recovery']], [0, 0])
    assert.equal(rows('notification_channels').find((c) => c['key'] === 'ops-slack')!['notify_on_recovery'], 1)
  })

  it('lists the changes with channels first, then monitors', async () => {
    const result = await applied(baseline())
    assert.deepEqual(result['changes'].map((c: Doc) => `${c['kind']}:${c['key'] ?? ''}`), [
      'NotificationChannel:ops-slack', 'NotificationChannel:pager', 'Monitor:billing-db', 'Monitor:nightly-job', 'Monitor:public-site',
    ])
  })

  it('gives a new webhook monitor a heartbeat token', async () => {
    await applied(baseline())
    assert.match(rows('monitors').find((m) => m['key'] === 'nightly-job')!['webhook_token'], /^[0-9a-f]{48}$/)
  })

  it('records the import and what it changed in the audit log', async () => {
    await applied(baseline())
    const entries = rows('audit_log')
    assert.deepEqual(entries.filter((e) => e['entity_type'] === 'monitor').map((e) => e['action']), ['create', 'create', 'create'])
    assert.equal(entries.filter((e) => e['entity_type'] === 'notification_channel').length, 2)
    const summary = entries.find((e) => e['entity_type'] === 'config')!
    assert.equal(summary['user_email'], 'admin@example.test')
    assert.deepEqual(JSON.parse(summary['diff']), { created: 5, updated: 0, unchanged: 0 })
    assert.equal(JSON.stringify(entries).includes('p4ss'), false, 'no secret in the audit log')
  })

  it('takes a single object, which is how one monitor is added', async () => {
    const result = await applied(heartbeat())
    assert.deepEqual(result['summary'], { create: 1, update: 0, unchanged: 0 })
    assert.equal(rows('monitors').length, 1)
  })
})

// ── repeating and round trips ───────────────────────────────────────────────────────────────────────────────────

describe('importing what is already there', () => {
  it('is a no-op the second time: nothing written, nothing audited', async () => {
    await applied(baseline())
    const before = everything()
    const auditCount = rows('audit_log').length
    const result = await applied(baseline())
    assert.deepEqual(result['summary'], { create: 0, update: 0, unchanged: 5 })
    assert.equal(everything(), before)
    assert.equal(rows('audit_log').length, auditCount)
  })

  it('reads its own export back as no change, keeping every secret', async () => {
    await applied(baseline())
    const before = everything()
    const file = await exported()
    assert.equal(file.find((d) => d['key'] === 'public-site')!['config'].auth.basic.password, SECRET_MASK)
    const result = await applied(file)
    assert.deepEqual(result['summary'], { create: 0, update: 0, unchanged: 5 })
    assert.equal(everything(), before)
    assert.equal(stored('public-site').auth.basic.password, 'p4ss')
    assert.equal(stored('billing-db').password, 'db-secret')
  })

  it('reads the YAML export, several documents in one file, back the same way', async () => {
    await applied(baseline())
    const yaml = (await app.inject({ url: '/config/export', headers: bearer })).body
    assert.equal((yaml.match(/^---$/gm) ?? []).length, 4)
    const result = await post('apply', yaml, 'application/yaml')
    assert.equal(result.statusCode, 200, result.body)
    assert.deepEqual(result.json().summary, { create: 0, update: 0, unchanged: 5 })
  })

  it('reads a single exported object back, which is how one object is edited and put back', async () => {
    await applied(baseline())
    const one = (await app.inject({ url: '/config/export?kind=Monitor&key=public-site', headers: bearer })).body
    const edited = one.replace('intervalSecs: 30', 'intervalSecs: 45')
    assert.notEqual(edited, one)
    const result = await post('apply', edited, 'application/yaml')
    assert.deepEqual(result.json().summary, { create: 0, update: 1, unchanged: 0 })
    assert.deepEqual(change(result.json(), 'Monitor', 'public-site').fields, ['intervalSecs'])
    assert.equal(rows('monitors').find((m) => m['key'] === 'public-site')!['interval_secs'], 45)
    assert.equal(stored('public-site').auth.basic.password, 'p4ss', 'the masked secret stayed')
  })
})

// ── changing ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('importing a changed file', () => {
  it('updates only what differs and says which settings changed, never their values', async () => {
    await applied(baseline())
    const token = rows('monitors').find((m) => m['key'] === 'nightly-job')!['webhook_token']
    const untouched = rows('monitors').find((m) => m['key'] === 'billing-db')!['updated_at']
    await new Promise((resolve) => setTimeout(resolve, 5))

    const result = await applied([channel({ name: 'Operations Slack' }), pager(), database(), site({ intervalSecs: 45, dependsOn: [] }), heartbeat()])

    assert.deepEqual(result['summary'], { create: 0, update: 2, unchanged: 3 })
    assert.deepEqual(change(result, 'Monitor', 'public-site').fields, ['intervalSecs', 'dependsOn'])
    assert.deepEqual(change(result, 'NotificationChannel', 'ops-slack').fields, ['name'])
    assert.equal(JSON.stringify(result).includes('p4ss'), false)

    assert.equal(rows('monitors').find((m) => m['key'] === 'public-site')!['interval_secs'], 45)
    assert.equal(rows('monitor_dependencies').length, 0)
    assert.equal(rows('monitors').find((m) => m['key'] === 'nightly-job')!['webhook_token'], token, 'the heartbeat URL does not change')
    assert.equal(rows('monitors').find((m) => m['key'] === 'billing-db')!['updated_at'], untouched, 'an unchanged monitor is not touched')
    assert.equal(rows('notification_channels').find((c) => c['key'] === 'ops-slack')!['name'], 'Operations Slack')
  })

  it('never removes anything: what the file does not mention stays', async () => {
    await applied(baseline())
    const result = await applied(heartbeat())
    assert.deepEqual(result['summary'], { create: 0, update: 0, unchanged: 1 })
    await applied({ kind: 'Monitor', key: 'extra', name: 'Extra', type: 'webhook', config: {} })
    assert.equal(rows('monitors').length, 4)
    assert.equal(rows('notification_channels').length, 2)
  })

  it('takes a settings left out as its default, but keeps the links of nothing else', async () => {
    await applied(baseline())
    const result = await applied({ ...site(), intervalSecs: undefined, notifications: undefined })
    assert.deepEqual(change(result, 'Monitor', 'public-site').fields, ['intervalSecs', 'notifications'])
    assert.equal(rows('monitors').find((m) => m['key'] === 'public-site')!['interval_secs'], 60)
    assert.equal(rows('monitor_notification_channels').length, 0)
  })

  it('resets what was known about the certificate when the endpoint changes', async () => {
    await applied(baseline())
    sqlite.exec("UPDATE monitors SET cert_expires_at = 123, cert_checked_at = 5, cert_warned_days = 7 WHERE key = 'public-site'")
    await applied(site({ intervalSecs: 60 }))
    assert.deepEqual(rows('monitors').find((m) => m['key'] === 'public-site')!['cert_expires_at'], 123, 'unrelated change keeps it')

    const moved = site()
    moved['config'].url = 'https://moved.test'
    await applied(moved)
    const row = rows('monitors').find((m) => m['key'] === 'public-site')!
    assert.deepEqual([row['cert_expires_at'], row['cert_checked_at'], row['cert_warned_days']], [null, null, null])
  })

  it('changes the type of a monitor when the file says so', async () => {
    await applied(baseline())
    const result = await applied({ kind: 'Monitor', key: 'nightly-job', name: 'Nightly job', type: 'ping', config: { host: 'h', mode: 'tcp', port: 22 } })
    assert.deepEqual(change(result, 'Monitor', 'nightly-job').fields, ['type', 'config'])
    assert.equal(rows('monitors').find((m) => m['key'] === 'nightly-job')!['webhook_token'], null)
  })
})

// ── dry run ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('validating without applying', () => {
  it('reports the same plan an apply would carry out, and writes nothing', async () => {
    const before = everything()
    const preview = await validate(baseline())
    assert.equal(preview.statusCode, 200)
    assert.equal(preview.json().dryRun, true)
    assert.deepEqual(preview.json().summary, { create: 5, update: 0, unchanged: 0 })
    assert.equal(everything(), before)
    assert.equal(rows('audit_log').length, 0)

    const real = await applied(baseline())
    assert.deepEqual({ ...preview.json(), dryRun: false }, real)
  })

  it('refuses an invalid file the same way', async () => {
    assert.equal((await validate([{ kind: 'Carousel' }])).statusCode, 400)
  })
})

// ── secrets ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('secrets in a file', () => {
  it('refuses a mask for something that has no stored secret', async () => {
    const response = await apply(database({ config: { ...database()['config'], password: SECRET_MASK } }))
    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json().problems.map((p: Doc) => p['path']), ['Monitor[billing-db].config'])
    assert.match(response.json().problems[0].message, /^password is a masked placeholder/)
    assert.equal(rows('monitors').length, 0)
  })

  it('does not keep a stored secret while the monitor is pointed somewhere else', async () => {
    await applied(baseline())
    const file = (await exported()).filter((d) => d['key'] === 'public-site')
    file[0]!['config'].url = 'https://attacker.test'
    const response = await apply(file)
    assert.equal(response.statusCode, 400)
    assert.match(response.json().problems[0].message, /^url changed, so the stored secrets cannot be kept/)
    assert.equal(stored('public-site').url, 'https://example.test')

    file[0]!['config'].auth.basic.password = 'entered-again'
    assert.equal((await apply(file)).statusCode, 200)
    assert.deepEqual([stored('public-site').url, stored('public-site').auth.basic.password], ['https://attacker.test', 'entered-again'])
  })

  it('replaces a secret that is typed in, and clears one that is left out', async () => {
    await applied(baseline())
    const clear = site()
    delete clear['config'].auth.basic.password
    const result = await applied([database({ config: { ...database()['config'], password: 'rotated' } }), clear])
    assert.deepEqual(change(result, 'Monitor', 'billing-db').fields, ['config'])
    assert.equal(stored('billing-db').password, 'rotated')
    assert.equal('password' in stored('public-site').auth.basic, false)
  })

  it('refuses a half-edited mask and a secret that is not text', async () => {
    await applied(baseline())
    assert.equal((await apply(database({ config: { ...database()['config'], password: '•••••••' } }))).statusCode, 400)
    const response = await apply(database({ config: { ...database()['config'], password: 123456 } }))
    assert.equal(response.json().problems[0].message, 'password must be text')
    assert.equal(stored('billing-db').password, 'db-secret')
  })
})

// ── vault references ────────────────────────────────────────────────────────────────────────────────────────────

describe('vault references', () => {
  async function vault(name: string, secrets: string[] = []) {
    const now = Date.now()
    const [row] = await db.insert(vaults).values({ name, type: 'local', createdAt: now, updatedAt: now }).returning()
    const created = []
    for (const secret of secrets) {
      created.push((await db.insert(vaultSecrets).values({ vaultId: row!.id, name: secret, type: 'userpass', encryptedValue: 'x', createdAt: now, updatedAt: now }).returning())[0]!)
    }
    return { id: row!.id, secrets: created }
  }
  const withVault = (reference: unknown): Doc => database({ config: { host: 'db', port: 1, database: 'd', user: 'u', password: '', query: 'select 1', mode: 'fields', vault: reference } })
  const problem = async (reference: unknown) => (await apply(withVault(reference))).json().problems?.[0]

  it('turns the names of a vault and a secret into the ids stored here', async () => {
    const production = await vault('Production', ['db-login'])
    await applied(withVault({ vault: 'Production', secret: 'db-login', fieldMapping: { user: 'u' } }))
    assert.deepEqual(stored('billing-db').vault, { vaultId: production.id, secretId: production.secrets[0]!.id, fieldMapping: { user: 'u' } })
  })

  it('reads its own export back', async () => {
    await vault('Production', ['db-login'])
    await applied(withVault({ vault: 'Production', secret: 'db-login' }))
    const result = await applied(await exported())
    assert.deepEqual(result['summary'], { create: 0, update: 0, unchanged: 1 }, JSON.stringify(result))
  })

  it('says what is wrong with a reference', async () => {
    await vault('Production', ['db-login'])
    await vault('Twin')
    await vault('Twin')
    assert.match((await problem({ vault: 'Nope', secret: 'x' })).message, /^unknown vault "Nope"/)
    assert.match((await problem({ vault: 'Production', secret: 'x' })).message, /has no secret "x"/)
    assert.match((await problem({ vault: 'Twin', secret: 'x' })).message, /more than one vault is named "Twin"/)
    assert.match((await problem({ vault: '(deleted vault 3)', secret: 's' })).message, /no longer exists/)
    assert.match((await problem({ vault: 'Production', secret: '(deleted secret 9)' })).message, /no longer exists/)
    assert.match((await problem({ vaultId: 1, secretId: 2 })).message, /must name the vault and the secret/)
    assert.match((await problem({ vault: 'Production', secret: 'db-login', vaultId: 1 })).message, /does not use numeric ids/)
    assert.equal(rows('monitors').length, 0)
  })
})

// ── references between things ───────────────────────────────────────────────────────────────────────────────────

describe('references', () => {
  const problems = async (documents: Doc[]) => {
    const response = await apply(documents)
    assert.equal(response.statusCode, 400, response.body)
    assert.equal(rows('monitors').length, 0, 'nothing was written')
    return response.json().problems as Array<{ path: string; message: string }>
  }

  it('refuses channels and dependencies that do not exist', async () => {
    const list = await problems([channel(), pager(), database(), site({ notifications: ['nobody'], dependsOn: ['ghost', 'public-site'] })])
    assert.deepEqual(list.map((p) => `${p.path}: ${p.message}`), [
      'Monitor[public-site].notifications: unknown channel "nobody"',
      'Monitor[public-site].dependsOn: unknown monitor "ghost"',
      'Monitor[public-site].dependsOn: a monitor cannot depend on itself',
    ])
  })

  it('refuses a dependency cycle, also through monitors the file does not mention', async () => {
    const [cycle] = await problems([channel(), pager(), database({ dependsOn: ['public-site'] }), site()])
    assert.match(cycle!.message, /^dependency cycle: (billing-db → public-site → billing-db|public-site → billing-db → public-site)$/)

    await applied(baseline()) // public-site depends on billing-db
    const response = await apply(database({ dependsOn: ['public-site'] }))
    assert.equal(response.statusCode, 400)
    assert.match(response.json().problems[0].message, /^dependency cycle/)
  })

  it('lets a file refer to monitors and channels it does not contain, if they exist', async () => {
    await applied(baseline())
    const result = await applied({ kind: 'Monitor', key: 'extra', name: 'Extra', type: 'webhook', config: {}, notifications: ['pager'], dependsOn: ['billing-db'] })
    assert.deepEqual(result['summary'], { create: 1, update: 0, unchanged: 0 })
  })
})

describe('a file that is not valid', () => {
  it('lists every problem with its place instead of stopping at the first', async () => {
    const response = await apply([
      { kind: 'NotificationChannel', key: 'Bad Key', name: '', type: 'sms', enabled: 'yes', config: [] },
      { kind: 'NotificationChannel', key: 'dup', name: 'A', type: 'slack', colour: 'blue' },
      { kind: 'NotificationChannel', key: 'dup', name: 'B', type: 'slack' },
      { kind: 'Monitor', key: 'm', name: 'M', type: 'https', intervalSecs: 5, timeout: 10, config: 'url', tags: 'x' },
      'text',
      { kind: 'Carousel' },
      { name: 'no kind' },
    ])
    assert.equal(response.statusCode, 400)
    const list = response.json().problems as Array<{ path: string; message: string }>
    const paths = list.map((p) => p.path)
    for (const expected of ['document 1.key', 'document 1.name', 'document 1.type', 'document 1.enabled', 'document 1.config', 'NotificationChannel[dup].colour', 'document 3.key',
      'Monitor[m].timeout', 'Monitor[m]', 'document 5', 'document 6.kind', 'document 7.kind']) {
      assert.ok(paths.includes(expected), `${expected} in ${paths.join(', ')}`)
    }
    assert.equal(response.json().error, `${list[0]!.path}: ${list[0]!.message}`)
    assert.match(list.find((p) => p.path === 'document 6.kind')!.message, /is not a kind; use one of Monitor, NotificationChannel\b/)
  })

  it('needs documents, each with a kind', async () => {
    assert.equal((await apply([])).json().error, 'The file contains no documents')
    for (const body of ['text', 7, [[]], [null]]) {
      const response = await post('apply', JSON.stringify(body))
      assert.equal(response.statusCode, 400, JSON.stringify(body))
    }
    const layout = await apply({ kind: 'StatusPageLayout', root: { id: 'root', type: 'page' } })
    assert.match(layout.json().problems[0].message, /is not a kind/)
  })

  it('applies none of a file when one part of it cannot be written', async () => {
    // The channels are written first and the monitors after them: refuse the second monitor, as a full disk would.
    sqlite.exec("CREATE TRIGGER refuse_monitor BEFORE INSERT ON monitors WHEN NEW.key = 'public-site' BEGIN SELECT RAISE(ABORT, 'disk full'); END")
    try {
      const response = await apply(baseline())
      assert.equal(response.statusCode, 500)
      assert.ok(rows('monitors').length === 0)
    } finally {
      sqlite.exec('DROP TRIGGER refuse_monitor')
    }
    assert.equal(rows('notification_channels').length, 0, 'the channels written before the failure are gone')
    assert.equal(rows('monitors').length, 0)
    assert.equal(rows('audit_log').length, 0)
    assert.equal((await apply(baseline())).statusCode, 200, 'and the same file applies afterwards')
  })

  it('does not accept a channel the API would not accept', async () => {
    const response = await apply({ kind: 'NotificationChannel', key: 'tg', name: 'Bot', type: 'telegram', config: { chatId: '1' } })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().problems[0].message, 'Telegram needs a Bot Token')
  })

  it('does not accept a key that belongs to a different kind of object in the same file', async () => {
    const response = await apply([channel({ key: 'same' }), database({ key: 'same' })])
    assert.equal(response.statusCode, 200, 'a monitor and a channel may share a key: they are different namespaces')
  })
})

// ── YAML and JSON ───────────────────────────────────────────────────────────────────────────────────────────────

describe('request bodies', () => {
  it('reads a hand-written YAML file with several documents, comments and quoted times included', async () => {
    const yaml = `# Production status page
kind: NotificationChannel
key: ops-slack
name: Ops Slack
type: slack
config:
  webhookUrl: https://hooks.test/real-secret   # keep out of git: inject it before posting
alertPolicy:
  quietHours: { enabled: true, start: "22:00", end: "07:00", timezone: Europe/Warsaw, mode: defer }
---
kind: Monitor
key: site
name: Site
type: https
config:
  url: https://example.test
  method: GET
  expectedStatus: 200
`
    const response = await post('apply', yaml, 'application/yaml')
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json().summary, { create: 2, update: 0, unchanged: 0 })
    const policy = JSON.parse(rows('notification_channels')[0]!['alert_policy'])
    assert.deepEqual([policy.quietHours.enabled, policy.quietHours.start, policy.quietHours.timezone], [true, '22:00', 'Europe/Warsaw'])
  })

  it('accepts the other YAML media types, and nothing but YAML', async () => {
    const one = { kind: 'Monitor', key: 'one', name: 'One', type: 'webhook', config: {} }
    const yaml = stringify(one)
    assert.equal((await post('validate', yaml, 'text/yaml')).statusCode, 200)
    assert.equal((await post('validate', yaml, 'application/x-yaml')).statusCode, 200)
    assert.equal((await post('validate', yaml, 'application/yaml; charset=utf-8')).statusCode, 200)
    // JSON is refused before it is read, whatever it holds; so is a body with no type.
    for (const type of ['application/json', 'text/plain']) {
      const refused = await post('validate', JSON.stringify(one), type)
      assert.equal(refused.statusCode, 415, type)
      assert.match(refused.json().error, /Send the documents as YAML/)
    }
    assert.equal((await app.inject({ method: 'POST', url: '/config/apply', headers: bearer })).statusCode, 415)
    assert.equal(rows('monitors').length, 0)
  })

  it('ignores empty documents, such as a trailing separator', async () => {
    const response = await post('validate', 'kind: Monitor\nkey: one\nname: One\ntype: webhook\n---\n---\n', 'application/yaml')
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().summary, { create: 1, update: 0, unchanged: 0 })
  })

  it('answers a broken YAML file with the place of the mistake', async () => {
    const broken = await post('apply', 'kind: Monitor\nname: [\n', 'application/yaml')
    assert.equal(broken.statusCode, 400)
    assert.match(broken.json().error, /^Invalid YAML: .*line/s)
    const duplicate = await post('apply', 'kind: Monitor\nkind: Monitor\n', 'application/yaml')
    assert.equal(duplicate.statusCode, 400)
    assert.match(duplicate.json().error, /^Invalid YAML/)
    assert.equal((await post('apply', '', 'application/yaml')).json().error, 'The file contains no documents')
  })

  it('refuses a flood of aliases', async () => {
    const aliases = Array.from({ length: 40 }, () => '  - *a').join('\n')
    const response = await post('apply', `kind: Monitor\nanchors: &a [1, 2, 3]\nlist:\n${aliases}\n`, 'application/yaml')
    assert.equal(response.statusCode, 400)
  })
})
