import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { db, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { auditLog } from '../src/db/schema.js'
import { adminLocaleRoutes } from '../src/routes/locales.js'
import { incidentRoutes } from '../src/routes/incidents.js'
import { maintenanceRoutes } from '../src/routes/maintenance.js'
import { monitorRoutes } from '../src/routes/monitors.js'

const dataDir = mkdtempSync(join(tmpdir(), 'bsp-crud-test-'))
process.env['DATABASE_PATH'] = join(dataDir, 'test.sqlite')

const app = Fastify({ logger: false })

before(async () => {
  initDb()
  runMigrations()

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
  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('monitor CRUD', () => {
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
    assert.equal(stored.updates[0].body, 'Root cause identified')

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
