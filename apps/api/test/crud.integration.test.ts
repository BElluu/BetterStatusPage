import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { db } from '../src/db/client.js'
import { eq } from 'drizzle-orm'
import { auditLog, monitors } from '../src/db/schema.js'
import { adminLocaleRoutes } from '../src/routes/locales.js'
import { incidentRoutes } from '../src/routes/incidents.js'
import { maintenanceRoutes } from '../src/routes/maintenance.js'
import { monitorRoutes } from '../src/routes/monitors.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-crud-test-')

const app = Fastify({ logger: false })

before(async () => {
  initTestDb()

  app.addHook('preHandler', async (request) => {
    request.user = { userId: 1, email: 'admin@example.test', role: 'admin' }
  })
  await app.register(monitorRoutes, { prefix: '/monitors' })
  await app.register(incidentRoutes, { prefix: '/incidents' })
  await app.register(maintenanceRoutes, { prefix: '/maintenance' })
  await app.register(adminLocaleRoutes, { prefix: '/locales' })
  await app.ready()
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

describe('monitor CRUD', () => {
  it('re-reads the TLS certificate after a config change and forgets it when the URL changes', async () => {
    const config = { url: 'https://a.example.test', method: 'GET', expectedStatus: 200 }
    const created = await app.inject({ method: 'POST', url: '/monitors', payload: { name: 'Cert', type: 'https', config } })
    const id = created.json<{ id: number }>().id
    const expiresAt = Date.now() + 86_400_000
    await db.update(monitors).set({ certExpiresAt: expiresAt, certCheckedAt: Date.now(), certWarnedDays: 7 }).where(eq(monitors.id, id))

    const settingChanged = await app.inject({ method: 'PATCH', url: `/monitors/${id}`, payload: { config: { ...config, certExpiry: { enabled: true, warnDays: 30 } } } })
    assert.equal(settingChanged.json<{ certCheckedAt: number | null }>().certCheckedAt, null)
    assert.equal(settingChanged.json<{ certExpiresAt: number | null }>().certExpiresAt, expiresAt)

    const moved = await app.inject({ method: 'PATCH', url: `/monitors/${id}`, payload: { config: { ...config, url: 'https://b.example.test' } } })
    const body = moved.json<{ certExpiresAt: number | null; certWarnedDays: number | null }>()
    assert.equal(body.certExpiresAt, null)
    assert.equal(body.certWarnedDays, null)
    await app.inject({ method: 'DELETE', url: `/monitors/${id}` })
  })

  it('creates, reads, updates, links, and deletes monitors', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/monitors',
      payload: {
        name: 'Public API',
        type: 'https',
        intervalSecs: 30,
        timeoutMs: 2_000,
        retries: 2,
        config: { url: 'https://example.test', method: 'GET', expectedStatus: 200 },
        tags: [{ label: 'public', color: '#123456' }],
      },
    })
    assert.equal(created.statusCode, 200)
    const monitor = created.json()
    assert.equal(monitor.name, 'Public API')
    assert.deepEqual(monitor.tags, [{ label: 'public', color: '#123456' }])

    const dependencyResponse = await app.inject({
      method: 'POST',
      url: '/monitors',
      payload: { name: 'Database', type: 'ping', config: { host: '127.0.0.1', mode: 'tcp', port: 5432 } },
    })
    const dependency = dependencyResponse.json()

    const read = await app.inject({ method: 'GET', url: `/monitors/${monitor.id}` })
    assert.equal(read.statusCode, 200)
    assert.equal(read.json().config.url, 'https://example.test')

    const updated = await app.inject({
      method: 'PATCH',
      url: `/monitors/${monitor.id}`,
      payload: { name: 'Customer API', retries: 3 },
    })
    assert.equal(updated.statusCode, 200)
    assert.equal(updated.json().name, 'Customer API')
    assert.equal(updated.json().retries, 3)

    const linked = await app.inject({
      method: 'PUT',
      url: `/monitors/${monitor.id}/dependencies`,
      payload: { dependsOnIds: [monitor.id, dependency.id, 999_999] },
    })
    assert.equal(linked.statusCode, 200)

    const dependencies = await app.inject({
      method: 'GET',
      url: `/monitors/${monitor.id}/dependencies`,
    })
    assert.deepEqual(dependencies.json(), { dependsOnIds: [dependency.id] })

    assert.equal((await app.inject({ method: 'DELETE', url: `/monitors/${monitor.id}` })).statusCode, 204)
    assert.equal((await app.inject({ method: 'GET', url: `/monitors/${monitor.id}` })).statusCode, 404)
    assert.equal((await app.inject({ method: 'DELETE', url: `/monitors/${dependency.id}` })).statusCode, 204)
  })
})

describe('incident CRUD', () => {
  it('creates, updates, associates, and deletes incidents', async () => {
    const monitorResponse = await app.inject({
      method: 'POST',
      url: '/monitors',
      payload: { name: 'Incident target', type: 'webhook', config: {} },
    })
    const monitor = monitorResponse.json()

    const created = await app.inject({
      method: 'POST',
      url: '/incidents',
      payload: { title: 'Service unavailable', impact: 'major' },
    })
    assert.equal(created.statusCode, 200)
    const incident = created.json()
    assert.equal(incident.status, 'investigating')

    const associated = await app.inject({
      method: 'POST',
      url: `/incidents/${incident.id}/monitors`,
      payload: { monitorIds: [monitor.id] },
    })
    assert.equal(associated.statusCode, 200)

    const update = await app.inject({
      method: 'POST',
      url: `/incidents/${incident.id}/updates`,
      payload: { body: 'Root cause identified', status: 'identified' },
    })
    assert.equal(update.statusCode, 200)
    assert.equal(update.json().body, 'Root cause identified')

    const incidentAudit = (await db.select().from(auditLog))
      .filter((entry) => entry.entityType === 'incident' && entry.entityId === String(incident.id))
    const statusChange = incidentAudit.find((entry) => entry.action === 'update')
    assert.ok(statusChange, 'status change via timeline update is audited')
    assert.deepEqual(JSON.parse(statusChange.diff!), { status: { from: 'investigating', to: 'identified' } })

    const sameStatus = await app.inject({
      method: 'POST',
      url: `/incidents/${incident.id}/updates`,
      payload: { body: 'Still identified', status: 'identified' },
    })
    assert.equal(sameStatus.statusCode, 200)
    const updatesAfterNoop = (await db.select().from(auditLog))
      .filter((entry) => entry.entityType === 'incident' && entry.action === 'update' && entry.entityId === String(incident.id))
    assert.equal(updatesAfterNoop.length, 1, 'update without a status change is not audited')

    const patched = await app.inject({
      method: 'PATCH',
      url: `/incidents/${incident.id}`,
      payload: { title: 'Database unavailable', status: 'monitoring', impact: 'critical' },
    })
    assert.equal(patched.statusCode, 200)
    assert.equal(patched.json().impact, 'critical')

    const list = await app.inject({ method: 'GET', url: '/incidents' })
    const stored = list.json().find((item: { id: number }) => item.id === incident.id)
    assert.deepEqual(stored.monitorIds, [monitor.id])
    assert.equal(stored.updates[0].body, 'Still identified')

    assert.equal((await app.inject({ method: 'DELETE', url: `/incidents/${incident.id}` })).statusCode, 204)
    assert.equal((await app.inject({ method: 'DELETE', url: `/monitors/${monitor.id}` })).statusCode, 204)
  })
})

describe('maintenance CRUD', () => {
  it('creates, reads, updates, and deletes a scoped window', async () => {
    const monitor = (await app.inject({
      method: 'POST',
      url: '/monitors',
      payload: { name: 'Maintenance target', type: 'webhook', config: {} },
    })).json()
    const now = Date.now()

    const created = await app.inject({
      method: 'POST',
      url: '/maintenance',
      payload: {
        name: 'Database upgrade',
        startsAt: now - 1_000,
        endsAt: now + 60_000,
        description: 'Planned work',
        monitorIds: [monitor.id],
      },
    })
    assert.equal(created.statusCode, 200)
    const window = created.json()
    assert.deepEqual(window.monitorIds, [monitor.id])

    const active = await app.inject({ method: 'GET', url: '/maintenance/active' })
    assert.equal(active.json().some((item: { id: number }) => item.id === window.id), true)

    const updated = await app.inject({
      method: 'PATCH',
      url: `/maintenance/${window.id}`,
      payload: { name: 'Upgrade completed early', monitorIds: [] },
    })
    assert.equal(updated.statusCode, 200)
    assert.equal(updated.json().name, 'Upgrade completed early')
    assert.deepEqual(updated.json().monitorIds, [])

    assert.equal((await app.inject({ method: 'DELETE', url: `/maintenance/${window.id}` })).statusCode, 204)
    assert.equal((await app.inject({ method: 'GET', url: `/maintenance/${window.id}` })).statusCode, 404)
    assert.equal((await app.inject({ method: 'DELETE', url: `/monitors/${monitor.id}` })).statusCode, 204)
  })
})

describe('locale CRUD', () => {
  it('validates, creates, updates, defaults, and deletes locales', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/locales',
      payload: { code: 'INVALID!', name: 'Invalid' },
    })
    assert.equal(invalid.statusCode, 400)

    const created = await app.inject({
      method: 'POST',
      url: '/locales',
      payload: { code: 'pl', name: 'Polski' },
    })
    assert.equal(created.statusCode, 200)
    assert.deepEqual(created.json().translations, {})

    const updated = await app.inject({
      method: 'PATCH',
      url: '/locales/pl',
      payload: { name: 'Polski PL', translations: { 'status.operational': 'Działa' } },
    })
    assert.equal(updated.json().name, 'Polski PL')
    assert.equal(updated.json().translations['status.operational'], 'Działa')

    const madeDefault = await app.inject({ method: 'POST', url: '/locales/pl/set-default' })
    assert.equal(madeDefault.json().isDefault, 1)
    assert.equal((await app.inject({ method: 'DELETE', url: '/locales/pl' })).statusCode, 400)

    await app.inject({ method: 'POST', url: '/locales', payload: { code: 'de', name: 'Deutsch' } })
    assert.equal((await app.inject({ method: 'DELETE', url: '/locales/de' })).statusCode, 204)
    assert.equal((await app.inject({ method: 'GET', url: '/locales/de' })).statusCode, 404)
    const localeAudit = (await db.select().from(auditLog)).filter((entry) => entry.entityType === 'locale')
    assert.equal(localeAudit.some((entry) => entry.action === 'create'), true)
    assert.equal(localeAudit.some((entry) => entry.action === 'update'), true)
    assert.equal(localeAudit.some((entry) => entry.action === 'delete'), true)
  })
})
