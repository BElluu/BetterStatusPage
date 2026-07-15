import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { db, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { auditLog, monitors, notificationDeliveries } from '../src/db/schema.js'
import { auditRoutes } from '../src/routes/audit.js'
import { brandingRoutes } from '../src/routes/branding.js'
import { layoutRoutes } from '../src/routes/layout.js'
import { notificationRoutes } from '../src/routes/notifications.js'
import { DEFAULT_BRANDING_COLORS } from '@bsp/shared'

const dataDir = mkdtempSync(join(tmpdir(), 'bsp-admin-resources-'))
process.env['DATABASE_PATH'] = join(dataDir, 'test.sqlite')
process.env['UPLOAD_DIR'] = join(dataDir, 'uploads')
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
  await app.register(multipart)
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
    for (const [field, value] of Object.entries(DEFAULT_BRANDING_COLORS)) {
      assert.equal(defaults.json()[field], value)
    }
    const updated = await app.inject({ method: 'PATCH', url: '/branding', payload: { siteName: 'Acme Status', enabled: 1, primaryColor: '#112233', logoUrl: '/uploads/logo.png', logoLightUrl: '/uploads/logo-light.png', logoDarkUrl: '/uploads/logo-dark.png', chartBackground: '#223344', chartGridColor: '#334455', elevatedBackground: '#445566' } })
    assert.equal(updated.json().siteName, 'Acme Status')
    const persisted = (await app.inject({ url: '/branding' })).json()
    assert.equal(persisted.primaryColor, '#112233')
    assert.equal(persisted.logoUrl, '/uploads/logo.png')
    assert.equal(persisted.logoLightUrl, '/uploads/logo-light.png')
    assert.equal(persisted.logoDarkUrl, '/uploads/logo-dark.png')
    assert.equal(persisted.chartBackground, '#223344')
    assert.equal(persisted.chartGridColor, '#334455')
    assert.equal(persisted.elevatedBackground, '#445566')
    assert.equal((await db.select().from(auditLog)).some((entry) => entry.entityType === 'branding'), true)
  })

  it('replaces obsolete logo files and removes unreferenced uploads', async () => {
    async function upload(url: string, filename: string, contentType: string, bytes: number[]) {
      const boundary = '----bsp-test-boundary'
      const before = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`)
      const after = Buffer.from(`\r\n--${boundary}--\r\n`)
      return app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.concat([before, Buffer.from(bytes), after]),
      })
    }

    const png = await upload('/branding/logo/light', 'light.png', 'image/png', [0x89, 0x50, 0x4e, 0x47])
    assert.equal(png.statusCode, 200)
    assert.equal(existsSync(join(dataDir, 'uploads', 'logo-light.png')), true)

    const jpeg = await upload('/branding/logo/light', 'light.jpg', 'image/jpeg', [0xff, 0xd8, 0xff])
    assert.equal(jpeg.statusCode, 200)
    assert.equal(existsSync(join(dataDir, 'uploads', 'logo-light.jpg')), true)
    assert.equal(existsSync(join(dataDir, 'uploads', 'logo-light.png')), false)

    await app.inject({ method: 'PATCH', url: '/branding', payload: { logoLightUrl: null } })
    assert.equal(existsSync(join(dataDir, 'uploads', 'logo-light.jpg')), false)
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
