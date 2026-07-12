import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { db, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { auditLog, monitors, notificationDeliveries } from '../src/db/schema.js'
import { auditRoutes } from '../src/routes/audit.js'
import { brandingRoutes } from '../src/routes/branding.js'
import { layoutRoutes } from '../src/routes/layout.js'
import { notificationRoutes } from '../src/routes/notifications.js'

const dataDir = mkdtempSync(join(tmpdir(), 'bsp-admin-resources-'))
process.env['DATABASE_PATH'] = join(dataDir, 'test.sqlite')
const app = Fastify({ logger: false })
let monitorId = 0

before(async () => {
  initDb()
  runMigrations()
  const now = Date.now()
  monitorId = (await db.insert(monitors).values({
    name: 'API', type: 'webhook', intervalSecs: 60, timeoutMs: 1_000, retries: 1,
    config: '{}', currentStatus: 'pending', tags: '[]', createdAt: now, updatedAt: now,
  }).returning())[0]!.id
  app.addHook('preHandler', async (request) => {
    request.user = { userId: 1, email: 'admin@example.test', role: 'admin' }
  })
  await app.register(brandingRoutes, { prefix: '/branding' })
  await app.register(layoutRoutes, { prefix: '/layout' })
  await app.register(notificationRoutes, { prefix: '/notifications' })
  await app.register(auditRoutes, { prefix: '/audit' })
  await app.ready()
})

after(async () => {
  await app.close()
  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('branding and layout', () => {
  it('returns defaults and persists branding updates', async () => {
    const defaults = await app.inject({ url: '/branding' })
    assert.equal(defaults.json().siteName, 'Status Page')
    const updated = await app.inject({ method: 'PATCH', url: '/branding', payload: { siteName: 'Acme Status', enabled: 1, primaryColor: '#112233' } })
    assert.equal(updated.json().siteName, 'Acme Status')
    assert.equal((await app.inject({ url: '/branding' })).json().primaryColor, '#112233')
    assert.equal((await db.select().from(auditLog)).some((entry) => entry.entityType === 'branding'), true)
  })

  it('creates and replaces the page layout', async () => {
    assert.deepEqual((await app.inject({ url: '/layout' })).json().children, [])
    const tree = { id: 'root', type: 'page', children: [{ id: 'text', type: 'text', name: 'Intro', markdown: 'Hello' }] }
    assert.deepEqual((await app.inject({ method: 'PUT', url: '/layout', payload: { tree } })).json(), tree)
    assert.deepEqual((await app.inject({ url: '/layout' })).json(), tree)
    assert.equal((await db.select().from(auditLog)).some((entry) => entry.entityType === 'layout'), true)
  })
})

describe('notification configuration', () => {
  it('manages channels, monitor assignments, and SMTP settings', async () => {
    const created = await app.inject({
      method: 'POST', url: '/notifications/channels',
      payload: { name: 'Operations', type: 'slack', config: { webhookUrl: 'https://example.test/hook' }, enabled: 1, notifyOnRecovery: 1 },
    })
    assert.equal(created.statusCode, 200)
    const channel = created.json()
    assert.equal(channel.config.webhookUrl, 'https://example.test/hook')

    const patched = await app.inject({ method: 'PATCH', url: `/notifications/channels/${channel.id}`, payload: { name: 'Primary operations', enabled: 0 } })
    assert.equal(patched.json().name, 'Primary operations')
    assert.equal(patched.json().enabled, 0)

    await app.inject({ method: 'PUT', url: `/notifications/monitor/${monitorId}/channels`, payload: { channelIds: [channel.id] } })
    assert.deepEqual((await app.inject({ url: `/notifications/monitor/${monitorId}/channels` })).json(), [channel.id])

    const smtp = await app.inject({ method: 'PUT', url: '/notifications/smtp', payload: {
      host: 'smtp.example.test', port: 587, secure: 0, user: 'mailer', password: 'secret',
      fromAddress: 'status@example.test', fromName: 'Status',
    } })
    assert.equal(smtp.statusCode, 200)
    const readSmtp = (await app.inject({ url: '/notifications/smtp' })).json()
    assert.equal(readSmtp.host, 'smtp.example.test')
    assert.equal(readSmtp.password, '••••••••')

    const deliveryNow = Date.now()
    const [delivery] = await db.insert(notificationDeliveries).values({
      channelId: channel.id, channelName: patched.json().name, channelType: 'slack',
      monitorId, monitorName: 'API', eventType: 'alert', status: 'failed', targetStatus: 'down', previousStatus: 'up',
      variables: JSON.stringify({ monitor_name: 'API', monitor_type: 'webhook', status: 'down', previous_status: 'up', error_message: 'timeout', checked_at: new Date(deliveryNow).toISOString() }),
      attemptCount: 3, maxAttempts: 3, nextAttemptAt: null, lastAttemptAt: deliveryNow,
      lastError: 'timeout', createdAt: deliveryNow, updatedAt: deliveryNow,
    }).returning()
    const history = await app.inject({ url: '/notifications/deliveries?status=failed&channelType=slack' })
    assert.equal(history.statusCode, 200)
    assert.equal(history.json().total, 1)
    assert.equal(history.json().deliveries[0].id, delivery!.id)
    assert.equal((await app.inject({ url: `/notifications/deliveries/${delivery!.id}` })).statusCode, 200)
    const retried = await app.inject({ method: 'POST', url: `/notifications/deliveries/${delivery!.id}/retry` })
    assert.equal(retried.statusCode, 200)
    assert.equal(retried.json().attemptCount, 4)
    assert.equal((await db.select().from(auditLog)).some((entry) => entry.entityType === 'notification_delivery'), true)

    assert.equal((await app.inject({ method: 'DELETE', url: `/notifications/channels/${channel.id}` })).statusCode, 204)
  })
})

describe('audit API', () => {
  it('filters, paginates, and parses audit entries', async () => {
    const now = Date.now()
    await db.insert(auditLog).values([
      { userId: 1, userEmail: 'admin@example.test', action: 'create', entityType: 'monitor', entityId: '1', entityName: 'API', diff: '{"name":{"to":"API"}}', timestamp: now - 10 },
      { userId: 2, userEmail: 'operator@example.test', action: 'update', entityType: 'incident', entityId: '2', entityName: 'Outage', diff: null, timestamp: now },
    ])
    const response = await app.inject({ url: `/audit?userEmail=admin&entityType=monitor&action=create&from=${now - 20}&to=${now}` })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().total, 1)
    assert.deepEqual(response.json().entries[0].diff, { name: { to: 'API' } })
    assert.equal((await app.inject({ url: '/audit?limit=1&page=2' })).json().entries.length, 1)
  })
})
