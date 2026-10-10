import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { parse } from 'yaml'
import { db } from '../src/db/client.js'
import { vaultSecrets, vaults } from '../src/db/schema.js'
import { configRoutes } from '../src/routes/config.js'
import { layoutRoutes } from '../src/routes/layout.js'
import { monitorRoutes } from '../src/routes/monitors.js'
import { notificationRoutes } from '../src/routes/notifications.js'
import { SECRET_MASK } from '../src/services/secretFields.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-config-export-')
const app = Fastify({ logger: false })
const ids: Record<string, number> = {}

const send = async (method: 'POST' | 'PUT', url: string, payload: unknown) => {
  const response = await app.inject({ method, url, payload: payload as Record<string, unknown> })
  assert.equal(response.statusCode, 200, `${method} ${url}: ${response.body}`)
  return response.json()
}

before(async () => {
  initTestDb()
  app.addHook('preHandler', async (request) => {
    request.user = { userId: 1, email: 'admin@example.test', role: 'admin' }
  })
  await app.register(monitorRoutes, { prefix: '/monitors' })
  await app.register(notificationRoutes, { prefix: '/notifications' })
  await app.register(layoutRoutes, { prefix: '/layout' })
  await app.register(configRoutes, { prefix: '/config' })
  await app.ready()

  const now = Date.now()
  const [prod] = await db.insert(vaults).values({ name: 'Production', type: 'local', createdAt: now, updatedAt: now }).returning()
  const [login] = await db.insert(vaultSecrets).values({ vaultId: prod!.id, name: 'db-login', type: 'userpass', encryptedValue: 'x', createdAt: now, updatedAt: now }).returning()
  const [bot] = await db.insert(vaultSecrets).values({ vaultId: prod!.id, name: 'bot-token', type: 'value', encryptedValue: 'x', createdAt: now, updatedAt: now }).returning()
  Object.assign(ids, { vault: prod!.id, login: login!.id, bot: bot!.id })

  const channels = {
    ops: await send('POST', '/notifications/channels', { name: 'Ops Slack', type: 'slack', notifyOnRecovery: 1, config: { webhookUrl: 'https://hooks.slack.test/T0/B0/secretpart', text: 'Down: {{monitor_name}}' } }),
    bot: await send('POST', '/notifications/channels', { name: 'Telegram bot', key: 'tg', type: 'telegram', enabled: 0, config: { chatId: '-100500', vault: { vaultId: ids['vault'], secretId: ids['bot'] } } }),
  }
  const site = await send('POST', '/monitors', {
    name: 'Public site', type: 'https', intervalSecs: 30, tags: [{ label: 'prod', color: '#00ff00' }],
    config: { url: 'https://example.test', method: 'GET', expectedStatus: 200, headers: { Authorization: 'Bearer plaintext-token', Accept: 'application/json' }, auth: { type: 'basic', basic: { username: 'svc', password: 'plaintext-pass' } } },
  })
  const database = await send('POST', '/monitors', {
    name: 'Billing DB', type: 'postgresql',
    config: { host: 'db.internal', port: 5432, database: 'billing', user: 'app', password: '', query: 'select 1', mode: 'fields', vault: { vaultId: ids['vault'], secretId: ids['login'], fieldMapping: { user: 'u', password: 'p' } } },
  })
  const heartbeat = await send('POST', '/monitors', { name: 'Nightly job', type: 'webhook', config: {} })
  Object.assign(ids, { site: site.id, database: database.id, heartbeat: heartbeat.id })

  await send('PUT', `/monitors/${site.id}/dependencies`, { dependsOnIds: [database.id] })
  await send('PUT', `/notifications/monitor/${site.id}/channels`, { channelIds: [channels.bot.id, channels.ops.id] })
  await send('PUT', '/layout', {
    tree: {
      id: 'root', type: 'page', children: [
        { id: 'g1', type: 'group', label: 'Core', collapsible: true, children: [
          { id: 'm1', type: 'monitor', monitorId: site.id, showUptimeBar: true },
          { id: 'c1', type: 'chart', monitorId: database.id },
        ] },
        { id: 't1', type: 'text', text: 'Hello' },
        { id: 'm2', type: 'monitor', monitorId: 987654, showUptimeBar: false },
      ],
    },
  })
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

const exportJson = async () => (await app.inject({ url: '/config/export?format=json' })).json()

describe('config export', () => {
  it('describes monitors and channels by key, sorted, without numeric ids or runtime state', async () => {
    const config = await exportJson()
    assert.equal(config.version, 1)
    assert.deepEqual(config.monitors.map((m: { key: string }) => m.key), ['billing-db', 'nightly-job', 'public-site'])
    assert.deepEqual(config.channels.map((c: { key: string }) => c.key), ['ops-slack', 'tg'])
    // Layout nodes have ids of their own; monitors and channels must not.
    const text = JSON.stringify([config.monitors, config.channels])
    for (const forbidden of ['"id":', 'currentStatus', 'lastCheckedAt', 'webhookToken', 'createdAt', 'updatedAt', 'certExpiresAt']) {
      assert.equal(text.includes(forbidden), false, forbidden)
    }
    assert.deepEqual(Object.keys(config.monitors[0]), ['key', 'name', 'type', 'intervalSecs', 'timeoutMs', 'retries', 'failureThreshold', 'recoveryThreshold', 'config', 'tags', 'notifications', 'dependsOn'])
  })

  it('carries the settings and booleans the way a person would write them', async () => {
    const { monitors: exported, channels } = await exportJson()
    const site = exported.find((m: { key: string }) => m.key === 'public-site')
    assert.deepEqual([site.intervalSecs, site.tags], [30, [{ label: 'prod', color: '#00ff00' }]])
    const ops = channels.find((c: { key: string }) => c.key === 'ops-slack')
    assert.deepEqual([ops.enabled, ops.notifyOnRecovery], [true, true])
    assert.equal(channels.find((c: { key: string }) => c.key === 'tg').enabled, false)
    assert.equal(ops.alertPolicy.throttle.maxAlerts, 3, 'the alert policy is written out in full')
  })

  it('never writes a secret, only where one belongs', async () => {
    const config = await exportJson()
    const text = JSON.stringify(config)
    for (const secret of ['plaintext-pass', 'plaintext-token', 'secretpart']) assert.equal(text.includes(secret), false, secret)
    const site = config.monitors.find((m: { key: string }) => m.key === 'public-site')
    assert.equal(site.config.auth.basic.password, SECRET_MASK)
    assert.equal(site.config.auth.basic.username, 'svc')
    assert.deepEqual(site.config.headers, { Authorization: SECRET_MASK, Accept: 'application/json' })
    assert.equal(config.channels.find((c: { key: string }) => c.key === 'ops-slack').config.webhookUrl, SECRET_MASK)
  })

  it('names vault secrets instead of numbering them', async () => {
    const config = await exportJson()
    const database = config.monitors.find((m: { key: string }) => m.key === 'billing-db')
    assert.deepEqual(database.config.vault, { vault: 'Production', secret: 'db-login', fieldMapping: { user: 'u', password: 'p' } })
    assert.deepEqual(config.channels.find((c: { key: string }) => c.key === 'tg').config.vault, { vault: 'Production', secret: 'bot-token' })
  })

  it('links monitors to channels and dependencies by key', async () => {
    const { monitors: exported } = await exportJson()
    const site = exported.find((m: { key: string }) => m.key === 'public-site')
    assert.deepEqual(site.notifications, ['ops-slack', 'tg'])
    assert.deepEqual(site.dependsOn, ['billing-db'])
    const heartbeat = exported.find((m: { key: string }) => m.key === 'nightly-job')
    assert.deepEqual([heartbeat.notifications, heartbeat.dependsOn, heartbeat.config], [[], [], {}])
  })

  it('writes the layout with monitor keys in place of ids, and says when a monitor is gone', async () => {
    const { layout } = await exportJson()
    const [group, text, orphan] = layout.children
    assert.deepEqual(group.children[0], { id: 'm1', type: 'monitor', monitorKey: 'public-site', showUptimeBar: true })
    assert.deepEqual(group.children[1], { id: 'c1', type: 'chart', monitorKey: 'billing-db' })
    assert.deepEqual(text, { id: 't1', type: 'text', text: 'Hello' })
    assert.equal(orphan.monitorKey, '(deleted monitor 987654)')
    assert.equal(JSON.stringify(layout).includes('monitorId'), false)
  })

  it('is YAML by default, the same document as the JSON one, and reproducible', async () => {
    const response = await app.inject({ url: '/config/export' })
    assert.equal(response.statusCode, 200)
    assert.match(response.headers['content-type'] as string, /^application\/yaml/)
    assert.deepEqual(parse(response.body), await exportJson())
    assert.equal((await app.inject({ url: '/config/export?format=yaml' })).body, response.body)
    assert.match(response.body, /^version: 1\n/)
  })

  it('keeps long values on one line', async () => {
    const response = await app.inject({ url: '/config/export' })
    assert.ok(response.body.split('\n').some((line) => line.trim() === 'text: "Down: {{monitor_name}}"'))
    assert.equal(/^\s+>-?$/m.test(response.body), false, 'no folded scalars')
  })

  it('quotes what an older YAML parser would misread, so every tool reads the same file', async () => {
    const response = await app.inject({ url: '/config/export' })
    assert.match(response.body, /^\s+start: "22:00"$/m)
    assert.deepEqual(parse(response.body, { version: '1.1' }), await exportJson())
    assert.deepEqual(parse(response.body, { version: '1.2' }), await exportJson())
  })

  it('also quotes the odd cases: the merge key as a header name, and octal-looking text', async () => {
    await send('POST', '/monitors', {
      name: 'Odd values', type: 'https',
      config: { url: 'https://odd.test', method: 'GET', expectedStatus: 200, keyword: '0o17', headers: { '<<': 'merge', Accept: '=' } },
    })
    const response = await app.inject({ url: '/config/export' })
    assert.match(response.body, /^\s+!!str "<<": merge$/m)
    assert.match(response.body, /^\s+keyword: "0o17"$/m)
    assert.match(response.body, /^\s+Accept: "="$/m)
    const expected = await exportJson()
    for (const version of ['1.1', '1.2'] as const) {
      const read = parse(response.body, { version })
      assert.deepEqual(read, expected, `read as YAML ${version}`)
      const odd = read.monitors.find((m: { key: string }) => m.key === 'odd-values')
      assert.deepEqual([odd.config.keyword, odd.config.headers], ['0o17', { '<<': 'merge', Accept: '=' }])
    }
  })

  it('refuses an unknown format', async () => {
    const response = await app.inject({ url: '/config/export?format=toml' })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error, 'format must be yaml or json')
  })

})

describe('config export with ambiguous vault names', () => {
  it('fails only when the file would point at a vault it cannot name', async () => {
    const now = Date.now()
    await db.insert(vaults).values([
      { name: 'Twin', type: 'local', createdAt: now, updatedAt: now },
      { name: 'Twin', type: 'local', createdAt: now, updatedAt: now },
    ])
    // Unreferenced duplicates do not matter.
    assert.equal((await app.inject({ url: '/config/export' })).statusCode, 200)

    const twin = (await db.select().from(vaults)).find((v) => v.name === 'Twin')!
    const [secret] = await db.insert(vaultSecrets).values({ vaultId: twin.id, name: 's', type: 'value', encryptedValue: 'x', createdAt: now, updatedAt: now }).returning()
    await send('POST', '/monitors', { name: 'Uses twin', type: 'postgresql', config: { host: 'h', port: 1, database: 'd', user: 'u', password: '', query: 'select 1', mode: 'fields', vault: { vaultId: twin.id, secretId: secret!.id } } })
    const response = await app.inject({ url: '/config/export' })
    assert.equal(response.statusCode, 409)
    assert.match(response.json().error, /More than one vault is named "Twin"/)
  })
})
