import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { parse, parseAllDocuments } from 'yaml'
import { db } from '../src/db/client.js'
import { vaultSecrets, vaults } from '../src/db/schema.js'
import { configRoutes } from '../src/routes/config.js'
import { monitorRoutes } from '../src/routes/monitors.js'
import { notificationRoutes } from '../src/routes/notifications.js'
import { SECRET_MASK } from '../src/services/secretFields.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-config-export-')
const app = Fastify({ logger: false })
const ids: Record<string, number> = {}

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const send = async (method: 'POST' | 'PUT', url: string, payload: unknown) => {
  const response = await app.inject({ method, url, payload: payload as Record<string, unknown> })
  assert.equal(response.statusCode, 200, `${method} ${url}: ${response.body}`)
  return response.json()
}

before(async () => {
  initTestDb()
  app.addHook('preHandler', async (request) => {
    request.user = { userId: 1, email: 'admin@example.test', role: 'admin', sessionId: 'test-session' }
  })
  await app.register(monitorRoutes, { prefix: '/monitors' })
  await app.register(notificationRoutes, { prefix: '/notifications' })
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
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

const exportDocuments = async () => parseAllDocuments((await app.inject({ url: '/config/export' })).body).map((document) => document.toJS() as Doc)
const monitorsOf = async () => (await exportDocuments()).filter((d) => d['kind'] === 'Monitor')
const channelsOf = async () => (await exportDocuments()).filter((d) => d['kind'] === 'NotificationChannel')
const one = (documents: Doc[], key: string) => documents.find((d) => d['key'] === key)!

describe('config export', () => {
  it('is a list of documents with a kind: channels, then monitors (each sorted by key)', async () => {
    const documents = await exportDocuments()
    assert.deepEqual(documents.map((d) => `${d['kind']}:${d['key'] ?? ''}`), [
      'NotificationChannel:ops-slack', 'NotificationChannel:tg', 'Monitor:billing-db', 'Monitor:nightly-job', 'Monitor:public-site',
    ])
  })

  it('describes monitors and channels by key, without numeric ids or runtime state', async () => {
    const documents = await exportDocuments()
    const text = JSON.stringify(documents)
    for (const forbidden of ['"id":', 'currentStatus', 'lastCheckedAt', 'webhookToken', 'createdAt', 'updatedAt', 'certExpiresAt', 'version']) {
      assert.equal(text.includes(forbidden), false, forbidden)
    }
    assert.deepEqual(Object.keys((await monitorsOf())[0]!), ['kind', 'key', 'name', 'type', 'intervalSecs', 'timeoutMs', 'retries', 'failureThreshold', 'recoveryThreshold', 'config', 'tags', 'notifications', 'dependsOn'])
    assert.deepEqual(Object.keys((await channelsOf())[0]!), ['kind', 'key', 'name', 'type', 'enabled', 'notifyOnRecovery', 'config', 'alertPolicy'])
  })

  it('carries the settings and booleans the way a person would write them', async () => {
    const site = one(await monitorsOf(), 'public-site')
    assert.deepEqual([site['intervalSecs'], site['tags']], [30, [{ label: 'prod', color: '#00ff00' }]])
    const channels = await channelsOf()
    assert.deepEqual([one(channels, 'ops-slack')['enabled'], one(channels, 'ops-slack')['notifyOnRecovery']], [true, true])
    assert.equal(one(channels, 'tg')['enabled'], false)
    assert.equal(one(channels, 'ops-slack')['alertPolicy'].throttle.maxAlerts, 3, 'the alert policy is written out in full')
  })

  it('never writes a secret, only where one belongs', async () => {
    const text = JSON.stringify(await exportDocuments())
    for (const secret of ['plaintext-pass', 'plaintext-token', 'secretpart']) assert.equal(text.includes(secret), false, secret)
    const site = one(await monitorsOf(), 'public-site')
    assert.equal(site['config'].auth.basic.password, SECRET_MASK)
    assert.equal(site['config'].auth.basic.username, 'svc')
    assert.deepEqual(site['config'].headers, { Authorization: SECRET_MASK, Accept: 'application/json' })
    assert.equal(one(await channelsOf(), 'ops-slack')['config'].webhookUrl, SECRET_MASK)
  })

  it('names vault secrets instead of numbering them', async () => {
    assert.deepEqual(one(await monitorsOf(), 'billing-db')['config'].vault, { vault: 'Production', secret: 'db-login', fieldMapping: { user: 'u', password: 'p' } })
    assert.deepEqual(one(await channelsOf(), 'tg')['config'].vault, { vault: 'Production', secret: 'bot-token' })
  })

  it('links monitors to channels and dependencies by key', async () => {
    const monitors = await monitorsOf()
    const site = one(monitors, 'public-site')
    assert.deepEqual(site['notifications'], ['ops-slack', 'tg'])
    assert.deepEqual(site['dependsOn'], ['billing-db'])
    const heartbeat = one(monitors, 'nightly-job')
    assert.deepEqual([heartbeat['notifications'], heartbeat['dependsOn'], heartbeat['config']], [[], [], {}])
  })

  it('is YAML by default: one document per object, separated by ---, the same documents as the parsed stream, and reproducible', async () => {
    const response = await app.inject({ url: '/config/export' })
    assert.equal(response.statusCode, 200)
    assert.match(response.headers['content-type'] as string, /^application\/yaml/)
    assert.deepEqual(parseAllDocuments(response.body).map((d) => d.toJS()), await exportDocuments())
    assert.equal((response.body.match(/^---$/gm) ?? []).length, 4)
    assert.equal((await app.inject({ url: '/config/export' })).body, response.body)
    assert.match(response.body, /^kind: NotificationChannel\n/)
  })

  it('exports one object: by kind and key', async () => {
    const yaml = await app.inject({ url: '/config/export?kind=Monitor&key=public-site' })
    assert.equal(yaml.statusCode, 200)
    assert.match(yaml.body, /^kind: Monitor\nkey: public-site\n/)
    assert.equal(yaml.body.includes('---'), false)
    assert.deepEqual(parse(yaml.body), one(await monitorsOf(), 'public-site'))

    const channel = await app.inject({ url: '/config/export?kind=NotificationChannel&key=tg' })
    assert.deepEqual(parse(channel.body), one(await channelsOf(), 'tg'))
  })

  it('refuses a bad request for one object, and says when there is none', async () => {
    assert.equal((await app.inject({ url: '/config/export?kind=Carousel' })).statusCode, 400)
    const noKey = await app.inject({ url: '/config/export?kind=Monitor' })
    assert.equal(noKey.statusCode, 400)
    assert.equal(noKey.json().error, 'key is required to export a Monitor')
    const missing = await app.inject({ url: '/config/export?kind=Monitor&key=ghost' })
    assert.equal(missing.statusCode, 404)
    assert.match(missing.json().error, /There is no Monitor with the key "ghost"/)
  })

  it('keeps long values on one line', async () => {
    const response = await app.inject({ url: '/config/export' })
    assert.ok(response.body.split('\n').some((line) => line.trim() === 'text: "Down: {{monitor_name}}"'))
    assert.equal(/^\s+>-?$/m.test(response.body), false, 'no folded scalars')
  })

  it('quotes what an older YAML parser would misread, so every tool reads the same file', async () => {
    const response = await app.inject({ url: '/config/export' })
    assert.match(response.body, /^\s+start: "22:00"$/m)
    const expected = await exportDocuments()
    for (const version of ['1.1', '1.2'] as const) {
      assert.deepEqual(parseAllDocuments(response.body, { version }).map((d) => d.toJS()), expected, `read as YAML ${version}`)
    }
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
    const expected = await exportDocuments()
    for (const version of ['1.1', '1.2'] as const) {
      const read = parseAllDocuments(response.body, { version }).map((d) => d.toJS() as Doc)
      assert.deepEqual(read, expected, `read as YAML ${version}`)
      const odd = one(read.filter((d) => d['kind'] === 'Monitor'), 'odd-values')
      assert.deepEqual([odd['config'].keyword, odd['config'].headers], ['0o17', { '<<': 'merge', Accept: '=' }])
    }
  })

  it('has no other format than YAML: a format parameter changes nothing', async () => {
    const plain = await app.inject({ url: '/config/export' })
    assert.equal((await app.inject({ url: '/config/export?format=json' })).body, plain.body)
    assert.match(plain.headers['content-type'] as string, /^application\/yaml/)
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

    // Another object's YAML does not depend on it.
    const other = await app.inject({ url: '/config/export?kind=Monitor&key=public-site' })
    assert.equal(other.statusCode, 200)
    assert.match(other.body, /^kind: Monitor\nkey: public-site\n/)
  })
})
