import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { parse, stringify } from 'yaml'
import { db, sqlite } from '../src/db/client.js'
import { vaultSecrets, vaults } from '../src/db/schema.js'
import { configRoutes } from '../src/routes/config.js'
import { SECRET_MASK } from '../src/services/secretFields.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-config-import-')
const app = Fastify({ logger: false })

before(async () => {
  initTestDb()
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
    DELETE FROM notification_channels; DELETE FROM layout; DELETE FROM audit_log;
    DELETE FROM vault_secrets; DELETE FROM vaults;
  `)
})

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const baseline = (): Doc => ({
  version: 1,
  channels: [
    { key: 'ops-slack', name: 'Ops Slack', type: 'slack', notifyOnRecovery: true, config: { webhookUrl: 'https://hooks.test/real-secret' } },
    { key: 'pager', name: 'Pager', type: 'webhook', enabled: false, config: { url: 'https://pager.test/hook', method: 'POST', headers: { Authorization: 'Bearer pager-secret' } } },
  ],
  monitors: [
    { key: 'billing-db', name: 'Billing DB', type: 'postgresql', config: { host: 'db.internal', port: 5432, database: 'billing', user: 'app', password: 'db-secret', query: 'select 1', mode: 'fields' } },
    {
      key: 'public-site', name: 'Public site', type: 'https', intervalSecs: 30, tags: [{ label: 'prod', color: '#00ff00' }],
      config: { url: 'https://example.test', method: 'GET', expectedStatus: 200, auth: { type: 'basic', basic: { username: 'svc', password: 'p4ss' } } },
      notifications: ['ops-slack', 'pager'], dependsOn: ['billing-db'],
    },
    { key: 'nightly-job', name: 'Nightly job', type: 'webhook', config: {} },
  ],
  layout: {
    id: 'root', type: 'page', children: [
      { id: 'm1', type: 'monitor', monitorKey: 'public-site', showUptimeBar: true },
      { id: 'c1', type: 'chart', monitorKey: 'billing-db' },
    ],
  },
})

// A Bearer header is how an API token calls this, and it is what lets the request skip the CSRF check a browser needs.
const bearer = { authorization: 'Bearer test' }
const post = (path: string, payload: unknown, query = '', contentType?: string) => app.inject({
  method: 'POST', url: `/config/${path}${query}`,
  ...(contentType ? { headers: { ...bearer, 'content-type': contentType }, payload: payload as string } : { headers: bearer, payload: payload as Doc }),
})
const apply = (doc: unknown, query = '') => post('apply', doc, query)
const validate = (doc: unknown, query = '') => post('validate', doc, query)
const exported = async () => (await app.inject({ url: '/config/export?format=json' })).json() as Doc

async function applied(doc: Doc, query = '') {
  const response = await apply(doc, query)
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as Doc
}

const rows = (table: string) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all() as Array<Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any
const stored = (key: string) => JSON.parse((sqlite.prepare('SELECT config FROM monitors WHERE key = ?').get(key) as { config: string }).config)
const everything = () => JSON.stringify(['monitors', 'notification_channels', 'monitor_notification_channels', 'monitor_dependencies', 'layout'].map(rows))
const change = (result: Doc, kind: string, key?: string) => result['changes'].find((c: Doc) => c['kind'] === kind && c['key'] === key)

// ── creating ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('importing into an empty installation', () => {
  it('creates channels, monitors, their links and the layout', async () => {
    const result = await applied(baseline())
    assert.deepEqual(result['summary'], { create: 6, update: 0, unchanged: 0, delete: 0 })
    assert.equal(result['dryRun'], false)

    const site = rows('monitors').find((m) => m['key'] === 'public-site')!
    assert.deepEqual([site['name'], site['type'], site['interval_secs'], site['current_status']], ['Public site', 'https', 30, 'pending'])
    assert.deepEqual(JSON.parse(site['tags']), [{ label: 'prod', color: '#00ff00' }])
    assert.equal(stored('public-site').auth.basic.password, 'p4ss', 'secrets are stored as given')

    const keyOf = (table: string, id: number) => (sqlite.prepare(`SELECT key FROM ${table} WHERE id = ?`).get(id) as { key: string }).key
    assert.deepEqual(rows('monitor_notification_channels').map((l) => [keyOf('monitors', l['monitor_id']), keyOf('notification_channels', l['channel_id'])]).sort(),
      [['public-site', 'ops-slack'], ['public-site', 'pager']])
    assert.deepEqual(rows('monitor_dependencies').map((d) => [keyOf('monitors', d['dependent_id']), keyOf('monitors', d['depends_on_id'])]), [['public-site', 'billing-db']])

    const channel = rows('notification_channels').find((c) => c['key'] === 'pager')!
    assert.deepEqual([channel['enabled'], channel['notify_on_recovery']], [0, 0])
    assert.equal(rows('notification_channels').find((c) => c['key'] === 'ops-slack')!['notify_on_recovery'], 1)
  })

  it('gives a new webhook monitor a heartbeat token and points the layout at the new ids', async () => {
    await applied(baseline())
    assert.match(rows('monitors').find((m) => m['key'] === 'nightly-job')!['webhook_token'], /^[0-9a-f]{48}$/)
    const tree = JSON.parse(rows('layout')[0]!['tree'])
    const idOf = (key: string) => rows('monitors').find((m) => m['key'] === key)!['id']
    assert.deepEqual(tree.children, [
      { id: 'm1', type: 'monitor', monitorId: idOf('public-site'), showUptimeBar: true },
      { id: 'c1', type: 'chart', monitorId: idOf('billing-db') },
    ])
  })

  it('records the import and what it changed in the audit log', async () => {
    await applied(baseline())
    const entries = rows('audit_log')
    assert.deepEqual(entries.filter((e) => e['entity_type'] === 'monitor').map((e) => e['action']), ['create', 'create', 'create'])
    assert.equal(entries.filter((e) => e['entity_type'] === 'notification_channel').length, 2)
    const summary = entries.find((e) => e['entity_type'] === 'config')!
    assert.equal(summary['user_email'], 'admin@example.test')
    assert.deepEqual(JSON.parse(summary['diff']), { created: 6, updated: 0, deleted: 0, unchanged: 0, prune: false })
    assert.equal(JSON.stringify(entries).includes('p4ss'), false, 'no secret in the audit log')
  })
})

// ── repeating and round trips ───────────────────────────────────────────────────────────────────────────────────

describe('importing what is already there', () => {
  it('is a no-op the second time: nothing written, nothing audited', async () => {
    await applied(baseline())
    const before = everything()
    const auditCount = rows('audit_log').length
    const result = await applied(baseline())
    assert.deepEqual(result['summary'], { create: 0, update: 0, unchanged: 6, delete: 0 })
    assert.equal(everything(), before)
    assert.equal(rows('audit_log').length, auditCount)
  })

  it('reads its own export back as no change, keeping every secret', async () => {
    await applied(baseline())
    const before = everything()
    const file = await exported()
    assert.equal(file.monitors.find((m: Doc) => m['key'] === 'public-site').config.auth.basic.password, SECRET_MASK)
    const result = await applied(file)
    assert.deepEqual(result['summary'], { create: 0, update: 0, unchanged: 6, delete: 0 })
    assert.equal(everything(), before)
    assert.equal(stored('public-site').auth.basic.password, 'p4ss')
    assert.equal(stored('billing-db').password, 'db-secret')
  })

  it('reads the YAML export back the same way', async () => {
    await applied(baseline())
    const yaml = (await app.inject({ url: '/config/export' })).body
    const result = await post('apply', yaml, '', 'application/yaml')
    assert.equal(result.statusCode, 200, result.body)
    assert.deepEqual(result.json().summary, { create: 0, update: 0, unchanged: 6, delete: 0 })
  })
})

// ── changing ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('importing a changed file', () => {
  it('updates only what differs and says which settings changed, never their values', async () => {
    await applied(baseline())
    const token = rows('monitors').find((m) => m['key'] === 'nightly-job')!['webhook_token']
    const untouched = rows('monitors').find((m) => m['key'] === 'billing-db')!['updated_at']
    await new Promise((resolve) => setTimeout(resolve, 5))

    const doc = baseline()
    doc['monitors'][1].intervalSecs = 45
    doc['monitors'][1].dependsOn = []
    doc['channels'][0].name = 'Operations Slack'
    const result = await applied(doc)

    assert.deepEqual(result['summary'], { create: 0, update: 2, unchanged: 4, delete: 0 })
    assert.deepEqual(change(result, 'monitor', 'public-site').fields, ['intervalSecs', 'dependsOn'])
    assert.deepEqual(change(result, 'channel', 'ops-slack').fields, ['name'])
    assert.equal(JSON.stringify(result).includes('p4ss'), false)

    const site = rows('monitors').find((m) => m['key'] === 'public-site')!
    assert.equal(site['interval_secs'], 45)
    assert.equal(rows('monitor_dependencies').length, 0)
    assert.equal(rows('monitors').find((m) => m['key'] === 'nightly-job')!['webhook_token'], token, 'the heartbeat URL does not change')
    assert.equal(rows('monitors').find((m) => m['key'] === 'billing-db')!['updated_at'], untouched, 'an unchanged monitor is not touched')
    assert.equal(rows('notification_channels').find((c) => c['key'] === 'ops-slack')!['name'], 'Operations Slack')
  })

  it('keeps what the file does not mention: omitted sections are left alone', async () => {
    await applied(baseline())
    const before = everything()
    const result = await applied({ version: 1 }, '?prune=true')
    assert.deepEqual(result['summary'], { create: 0, update: 0, unchanged: 0, delete: 0 })
    assert.equal(everything(), before)

    await applied({ version: 1, monitors: [{ key: 'extra', name: 'Extra', type: 'webhook', config: {} }] })
    assert.equal(rows('monitors').length, 4, 'a monitor missing from the file stays unless prune is set')
    assert.equal(rows('notification_channels').length, 2)
  })

  it('resets what was known about the certificate when the endpoint changes', async () => {
    await applied(baseline())
    sqlite.exec("UPDATE monitors SET cert_expires_at = 123, cert_checked_at = 5, cert_warned_days = 7 WHERE key = 'public-site'")
    const same = baseline()
    same['monitors'][1].intervalSecs = 60
    await applied(same)
    assert.deepEqual(rows('monitors').find((m) => m['key'] === 'public-site')!['cert_expires_at'], 123, 'unrelated change keeps it')

    const moved = baseline()
    moved['monitors'][1].config.url = 'https://moved.test'
    await applied(moved)
    const site = rows('monitors').find((m) => m['key'] === 'public-site')!
    assert.deepEqual([site['cert_expires_at'], site['cert_checked_at'], site['cert_warned_days']], [null, null, null])
  })

  it('changes the type of a monitor when the file says so', async () => {
    await applied(baseline())
    const doc = baseline()
    doc['monitors'][2] = { key: 'nightly-job', name: 'Nightly job', type: 'ping', config: { host: 'h', mode: 'tcp', port: 22 } }
    const result = await applied(doc)
    assert.deepEqual(change(result, 'monitor', 'nightly-job').fields, ['type', 'config'])
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
    assert.deepEqual(preview.json().summary, { create: 6, update: 0, unchanged: 0, delete: 0 })
    assert.equal(everything(), before)
    assert.equal(rows('audit_log').length, 0)

    const real = await applied(baseline())
    assert.deepEqual({ ...preview.json(), dryRun: false }, real)
  })

  it('refuses an invalid file the same way', async () => {
    const response = await validate({ version: 2 })
    assert.equal(response.statusCode, 400)
  })
})

// ── prune ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('pruning', () => {
  it('removes monitors and channels the file leaves out, only when asked to, and only from sections it contains', async () => {
    await applied(baseline())
    const slim = { version: 1, monitors: baseline()['monitors'].slice(0, 1) } // billing-db only; channels and layout not mentioned

    const preview = (await validate(slim, '?prune=true')).json()
    assert.deepEqual(preview.summary, { create: 0, update: 1, unchanged: 1, delete: 2 })
    assert.deepEqual(preview.changes.find((c: Doc) => c['kind'] === 'layout'), { kind: 'layout', action: 'update', fields: ['nodes of removed monitors'] })
    assert.equal(rows('monitors').length, 3, 'a dry run deletes nothing')

    const result = await applied(slim, '?prune=true')
    assert.equal(result['prune'], true)
    assert.deepEqual(rows('monitors').map((m) => m['key']), ['billing-db'])
    assert.equal(rows('monitor_notification_channels').length, 0, 'links of a removed monitor go with it')
    assert.equal(rows('notification_channels').length, 2, 'channels were not in the file')
    const left = JSON.parse(rows('layout')[0]!['tree']).children.map((node: Doc) => node['id'])
    assert.deepEqual(left, ['c1'], 'the layout is not file-managed here, but it no longer shows the removed monitor')
    assert.deepEqual(rows('audit_log').filter((e) => e['action'] === 'delete').map((e) => e['entity_type']), ['monitor', 'monitor'])
  })

  it('removes a channel and the links to it', async () => {
    await applied(baseline())
    const doc = baseline()
    doc['channels'] = [doc['channels'][0]]
    doc['monitors'][1].notifications = ['ops-slack']
    await applied({ version: 1, channels: doc['channels'], monitors: doc['monitors'] }, '?prune=true')
    assert.deepEqual(rows('notification_channels').map((c) => c['key']), ['ops-slack'])
    assert.equal(rows('monitor_notification_channels').length, 1)
  })

  it('does not let a layout point at a monitor the same import removes', async () => {
    await applied(baseline())
    const doc = baseline()
    doc['monitors'] = doc['monitors'].slice(0, 1)
    const response = await apply(doc, '?prune=true')
    assert.equal(response.statusCode, 400)
    assert.ok(response.json().problems.some((p: Doc) => p['path'] === 'layout.children[0].monitorKey' && /unknown monitor "public-site"/.test(p['message'])))
    assert.equal(rows('monitors').length, 3, 'nothing was removed')
  })

  it('refuses anything but true or false', async () => {
    assert.equal((await apply(baseline(), '?prune=yes')).statusCode, 400)
  })
})

// ── secrets ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('secrets in a file', () => {
  it('refuses a mask for something that has no stored secret', async () => {
    const doc = baseline()
    doc['monitors'][0].config.password = SECRET_MASK
    const response = await apply(doc)
    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json().problems.map((p: Doc) => p['path']), ['monitors[billing-db].config'])
    assert.match(response.json().problems[0].message, /^password is a masked placeholder/)
    assert.equal(rows('monitors').length, 0)
  })

  it('does not keep a stored secret while the monitor is pointed somewhere else', async () => {
    await applied(baseline())
    const file = await exported()
    file['monitors'].find((m: Doc) => m['key'] === 'public-site').config.url = 'https://attacker.test'
    const response = await apply(file)
    assert.equal(response.statusCode, 400)
    assert.match(response.json().problems[0].message, /^url changed, so the stored secrets cannot be kept/)
    assert.equal(stored('public-site').url, 'https://example.test')

    file['monitors'].find((m: Doc) => m['key'] === 'public-site').config.auth.basic.password = 'entered-again'
    file['monitors'].find((m: Doc) => m['key'] === 'public-site').config.headers = undefined
    assert.equal((await apply(file)).statusCode, 200)
    assert.deepEqual([stored('public-site').url, stored('public-site').auth.basic.password], ['https://attacker.test', 'entered-again'])
  })

  it('replaces a secret that is typed in, and clears one that is left out', async () => {
    await applied(baseline())
    const doc = baseline()
    doc['monitors'][0].config.password = 'rotated'
    delete doc['monitors'][1].config.auth.basic.password
    const result = await applied(doc)
    assert.deepEqual(change(result, 'monitor', 'billing-db').fields, ['config'])
    assert.equal(stored('billing-db').password, 'rotated')
    assert.equal('password' in stored('public-site').auth.basic, false)
  })

  it('refuses a half-edited mask and a secret that is not text', async () => {
    await applied(baseline())
    const doc = baseline()
    doc['monitors'][0].config.password = '•••••••'
    assert.equal((await apply(doc)).statusCode, 400)
    doc['monitors'][0].config.password = 123456
    assert.equal((await apply(doc)).json().problems[0].message, 'password must be text')
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
  const withVault = (reference: unknown): Doc => {
    const doc = baseline()
    doc['monitors'][0].config = { host: 'db', port: 1, database: 'd', user: 'u', password: '', query: 'select 1', mode: 'fields', vault: reference }
    return { version: 1, monitors: [doc['monitors'][0]] }
  }
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
    assert.deepEqual(result['summary'], { create: 0, update: 0, unchanged: 2, delete: 0 }, JSON.stringify(result))
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
  const problems = async (mutate: (doc: Doc) => void) => {
    const doc = baseline()
    mutate(doc)
    const response = await apply(doc)
    assert.equal(response.statusCode, 400, response.body)
    assert.equal(rows('monitors').length, 0, 'nothing was written')
    return response.json().problems as Array<{ path: string; message: string }>
  }

  it('refuses channels and dependencies that do not exist', async () => {
    const list = await problems((doc) => { doc['monitors'][1].notifications = ['nobody']; doc['monitors'][1].dependsOn = ['ghost', 'public-site'] })
    assert.deepEqual(list.map((p) => `${p.path}: ${p.message}`), [
      'monitors[public-site].notifications: unknown channel "nobody"',
      'monitors[public-site].dependsOn: unknown monitor "ghost"',
      'monitors[public-site].dependsOn: a monitor cannot depend on itself',
    ])
  })

  it('refuses a dependency cycle, also through monitors the file does not mention', async () => {
    const [cycle] = await problems((doc) => { doc['monitors'][0].dependsOn = ['public-site'] })
    assert.match(cycle!.message, /^dependency cycle: (billing-db → public-site → billing-db|public-site → billing-db → public-site)$/)

    await applied(baseline()) // public-site depends on billing-db
    const response = await apply({ version: 1, monitors: [{ ...baseline()['monitors'][0], dependsOn: ['public-site'] }] })
    assert.equal(response.statusCode, 400)
    assert.match(response.json().problems[0].message, /^dependency cycle/)
  })

  it('lets a file refer to monitors and channels it does not contain, if they exist', async () => {
    await applied(baseline())
    const result = await applied({
      version: 1,
      monitors: [{ key: 'extra', name: 'Extra', type: 'webhook', config: {}, notifications: ['pager'], dependsOn: ['billing-db'] }],
    })
    assert.deepEqual(result['summary'], { create: 1, update: 0, unchanged: 0, delete: 0 })
  })
})

// ── layout ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the layout in a file', () => {
  const problems = async (layout: unknown) => {
    const doc = baseline()
    doc['layout'] = layout
    const response = await apply(doc)
    assert.equal(response.statusCode, 400, response.body)
    return response.json().problems as Array<{ path: string; message: string }>
  }

  it('is checked node by node', async () => {
    const list = await problems({
      id: 'root', type: 'page', children: [
        { id: 'a', type: 'monitor', monitorKey: 'ghost' },
        { id: 'a', type: 'text' },
        { id: 'b', type: 'carousel' },
        { id: 'c', type: 'monitor', monitorId: 3 },
        { id: 'd', type: 'chart', monitorKey: '(deleted monitor 12)' },
        { id: 'e', type: 'text', children: [] },
        { id: 'f', type: 'page', children: [] },
      ],
    })
    const byPath = Object.fromEntries(list.map((p) => [p.path, p.message]))
    assert.match(byPath['layout.children[0].monitorKey']!, /unknown monitor "ghost"/)
    assert.match(byPath['layout.children[1].id']!, /"a" is used by another node/)
    assert.match(byPath['layout.children[2].type']!, /must be one of/)
    assert.match(byPath['layout.children[3].monitorId']!, /names the monitor with monitorKey/)
    assert.match(byPath['layout.children[4].monitorKey']!, /no longer exists/)
    assert.match(byPath['layout.children[5].children']!, /cannot have children/)
    assert.match(byPath['layout.children[6].type']!, /only be the root/)
  })

  it('must start with a page', async () => {
    assert.match((await problems({ id: 'root', type: 'group', children: [] }))[0]!.message, /must be a page/)
    assert.match((await problems('page'))[0]!.message, /must be an object/)
  })

  it('is replaced as a whole, and left alone when the file has none', async () => {
    await applied(baseline())
    const before = rows('layout')[0]!['tree']
    const noLayout = baseline()
    delete noLayout['layout']
    assert.equal((await applied(noLayout))['summary'].unchanged, 5)
    assert.equal(rows('layout')[0]!['tree'], before)

    const doc = baseline()
    doc['layout'] = { id: 'root', type: 'page', children: [{ id: 'only', type: 'text', text: 'Hello' }] }
    const result = await applied(doc)
    assert.equal(change(result, 'layout').action, 'update')
    assert.deepEqual(JSON.parse(rows('layout')[0]!['tree']).children, [{ id: 'only', type: 'text', text: 'Hello' }])
  })

  it('may be the only thing in the file', async () => {
    const result = await applied({ version: 1, layout: { id: 'root', type: 'page', children: [{ id: 'note', type: 'text', text: 'Hi' }] } })
    assert.deepEqual(result['summary'], { create: 1, update: 0, unchanged: 0, delete: 0 })
    assert.deepEqual(JSON.parse(rows('layout')[0]!['tree']).children, [{ id: 'note', type: 'text', text: 'Hi' }])
  })

  it('treats an empty page as what an installation without a saved layout already shows', async () => {
    const result = await applied({ version: 1, layout: { id: 'root', type: 'page' } })
    assert.deepEqual(result['summary'], { create: 0, update: 0, unchanged: 1, delete: 0 })
    assert.equal(rows('layout').length, 0)
  })
})

// ── a bad file ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('a file that is not valid', () => {
  it('lists every problem with its place instead of stopping at the first', async () => {
    const response = await apply({
      version: 2, colour: 'blue',
      channels: [{ key: 'Bad Key', name: '', type: 'sms', enabled: 'yes', config: [] }, { key: 'dup', name: 'A', type: 'slack' }, { key: 'dup', name: 'B', type: 'slack' }],
      monitors: [{ key: 'm', name: 'M', type: 'https', intervalSecs: 5, timeout: 10, config: 'url', tags: 'x' }, 'text'],
    })
    assert.equal(response.statusCode, 400)
    const list = response.json().problems as Array<{ path: string; message: string }>
    const paths = list.map((p) => p.path)
    for (const expected of ['version', '(file).colour', 'channels[0].key', 'channels[0].name', 'channels[0].type', 'channels[0].enabled', 'channels[0].config', 'channels[2].key', 'monitors[m].timeout', 'monitors[m]', 'monitors[1]']) {
      assert.ok(paths.includes(expected), `${expected} in ${paths.join(', ')}`)
    }
    assert.equal(response.json().error, `${list[0]!.path}: ${list[0]!.message}`)
  })

  it('needs a document with the right version', async () => {
    for (const body of [[], 'text', 7, {}, { version: '1' }]) {
      const response = await post('apply', JSON.stringify(body), '', 'application/json')
      assert.equal(response.statusCode, 400, JSON.stringify(body))
    }
    assert.match((await apply({ version: 1, channels: 'x', monitors: {} })).json().problems.map((p: Doc) => p['message']).join(), /must be a list/)
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
    const response = await apply({ version: 1, channels: [{ key: 'tg', name: 'Bot', type: 'telegram', config: { chatId: '1' } }] })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().problems[0].message, 'Telegram needs a Bot Token')
  })
})

// ── YAML and JSON ───────────────────────────────────────────────────────────────────────────────────────────────

describe('request bodies', () => {
  it('reads a hand-written YAML file, comments and quoted times included', async () => {
    const yaml = `# Production status page
version: 1
channels:
  - key: ops-slack
    name: Ops Slack
    type: slack
    config:
      webhookUrl: https://hooks.test/real-secret   # keep out of git: inject it before posting
    alertPolicy:
      quietHours: { enabled: true, start: "22:00", end: "07:00", timezone: Europe/Warsaw, mode: defer }
monitors:
  - key: site
    name: Site
    type: https
    config:
      url: https://example.test
      method: GET
      expectedStatus: 200
`
    const response = await post('apply', yaml, '', 'application/yaml')
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json().summary, { create: 2, update: 0, unchanged: 0, delete: 0 })
    const policy = JSON.parse(rows('notification_channels')[0]!['alert_policy'])
    assert.deepEqual([policy.quietHours.enabled, policy.quietHours.start, policy.quietHours.timezone], [true, '22:00', 'Europe/Warsaw'])
  })

  it('accepts the other YAML media types and JSON', async () => {
    const yaml = stringify({ version: 1, monitors: [{ key: 'one', name: 'One', type: 'webhook', config: {} }] })
    assert.equal((await post('validate', yaml, '', 'text/yaml')).statusCode, 200)
    assert.equal((await post('validate', yaml, '', 'application/x-yaml')).statusCode, 200)
    assert.equal((await validate(parse(yaml))).statusCode, 200)
  })

  it('answers a broken YAML file with the place of the mistake', async () => {
    const broken = await post('apply', 'version: 1\nmonitors: [\n', '', 'application/yaml')
    assert.equal(broken.statusCode, 400)
    assert.match(broken.json().error, /^Invalid YAML: .*line/s)
    const duplicate = await post('apply', 'version: 1\nversion: 1\n', '', 'application/yaml')
    assert.equal(duplicate.statusCode, 400)
    assert.match(duplicate.json().error, /^Invalid YAML/)
    assert.equal((await post('apply', '', '', 'application/yaml')).statusCode, 400)
  })

  it('refuses a flood of aliases', async () => {
    const aliases = Array.from({ length: 40 }, () => '  - *a').join('\n')
    const bomb = `version: 1\nanchors: &a [1, 2, 3]\nlist:\n${aliases}\n`
    const response = await post('apply', bomb, '', 'application/yaml')
    assert.equal(response.statusCode, 400)
  })
})
