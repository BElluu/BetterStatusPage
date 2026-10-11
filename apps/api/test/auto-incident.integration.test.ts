import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { incidentMonitors, incidents, incidentTemplates, incidentUpdates, layout, monitorResults, monitors } from '../src/db/schema.js'
import { recordObservation } from '../src/workers/scheduler.js'
import { renderTemplate, formatDuration, resolveIncidentForRecovery } from '../src/services/autoIncident.js'
import { publicRoutes } from '../src/routes/public.js'
import { refreshPublishedMonitorIds } from '../src/services/publishedMonitors.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-auto-incident-test-')
const down = { status: 'down' as const, responseMs: null, error: 'connection refused' }
const up = { status: 'up' as const, responseMs: 10, error: null }

async function addMonitor(overrides: Partial<typeof monitors.$inferInsert> = {}) {
  const now = Date.now()
  return (await db.insert(monitors).values({
    name: 'API', type: 'webhook', config: '{}', currentStatus: 'up', alertConfirmedStatus: 'up',
    autoIncidentMinutes: 5, createdAt: now, updatedAt: now, ...overrides,
  }).returning())[0]!
}

async function publishOnStatusPage(monitorId: number) {
  await db.insert(layout).values({
    id: 1, updatedAt: Date.now(),
    tree: JSON.stringify({ id: 'root', type: 'page', children: [{ id: 'm', type: 'monitor', monitorId, showUptimeBar: true }] }),
  })
  await refreshPublishedMonitorIds()
}

const reload = async (id: number) => (await db.select().from(monitors).where(eq(monitors.id, id)))[0]!

before(() => { initTestDb() })
beforeEach(async () => {
  await db.delete(incidentUpdates)
  await db.delete(incidentMonitors)
  await db.delete(incidents)
  await db.delete(monitorResults)
  await db.delete(monitors)
  await db.delete(layout)
})
after(() => { teardownTestDb(testDb) })

describe('template rendering', () => {
  it('replaces known placeholders and leaves unknown ones visible', () => {
    assert.equal(renderTemplate('{{monitor}} down {{ duration }} {{oops}}', { monitor: 'API', duration: '5 min' }), 'API down 5 min {{oops}}')
  })
  it('formats durations', () => {
    assert.equal(formatDuration(30_000), '1 min')
    assert.equal(formatDuration(65 * 60_000), '1 h 5 min')
    assert.equal(formatDuration(120 * 60_000), '2 h')
  })
})

describe('automatic incidents', () => {
  it('seeds one default template', async () => {
    const defaults = await db.select().from(incidentTemplates).where(eq(incidentTemplates.isDefault, 1))
    assert.equal(defaults.length, 1)
  })

  it('waits for the configured time, opens one draft, and resolves it on recovery', async () => {
    const monitor = await addMonitor()
    await recordObservation(monitor, down)
    assert.equal((await db.select().from(incidents)).length, 0, 'too early')
    const failing = await reload(monitor.id)
    assert.ok(failing.failingSince)

    await db.update(monitors).set({ failingSince: Date.now() - 6 * 60_000 }).where(eq(monitors.id, monitor.id))
    await recordObservation(await reload(monitor.id), down)
    await recordObservation(await reload(monitor.id), down)
    const opened = await db.select().from(incidents)
    assert.equal(opened.length, 1, 'only one open incident per monitor')
    assert.equal(opened[0]!.draft, 1)
    assert.equal(opened[0]!.autoMonitorId, monitor.id)
    assert.equal(opened[0]!.title, 'API is unavailable')
    assert.equal((await db.select().from(incidentMonitors)).length, 1)

    await recordObservation(await reload(monitor.id), up)
    const resolved = (await db.select().from(incidents))[0]!
    assert.equal(resolved.status, 'resolved')
    assert.ok(resolved.resolvedAt)
    const updates = await db.select().from(incidentUpdates)
    assert.equal(updates.length, 2)
    assert.equal((await reload(monitor.id)).failingSince, null)
  })

  it('publishes straight away in published mode and uses the chosen template', async () => {
    const now = Date.now()
    const template = (await db.insert(incidentTemplates).values({
      name: 'Custom', title: 'Outage: {{monitor}}', body: 'Down: {{error}}', resolvedBody: 'Back after {{duration}}',
      impact: 'critical', isDefault: 0, createdAt: now, updatedAt: now,
    }).returning())[0]!
    const monitor = await addMonitor({ autoIncidentMode: 'published', autoIncidentTemplateId: template.id })
    await publishOnStatusPage(monitor.id)
    await recordObservation(monitor, down)
    await db.update(monitors).set({ failingSince: Date.now() - 6 * 60_000 }).where(eq(monitors.id, monitor.id))
    await recordObservation(await reload(monitor.id), down)
    const incident = (await db.select().from(incidents))[0]!
    assert.equal(incident.draft, 0)
    assert.equal(incident.impact, 'critical')
    assert.equal(incident.title, 'Outage: API')
    // Check errors never reach a published incident.
    assert.equal((await db.select().from(incidentUpdates))[0]!.body, 'Down: ')
  })

  it('keeps an internal monitor incident a draft even in published mode', async () => {
    const monitor = await addMonitor({ autoIncidentMode: 'published' })
    await refreshPublishedMonitorIds()
    await recordObservation(monitor, down)
    await db.update(monitors).set({ failingSince: Date.now() - 6 * 60_000 }).where(eq(monitors.id, monitor.id))
    await recordObservation(await reload(monitor.id), down)
    assert.equal((await db.select().from(incidents))[0]!.draft, 1)
  })

  it('resolves once when two recoveries race on the same stale monitor row', async () => {
    const monitor = await addMonitor()
    await recordObservation(monitor, down)
    await db.update(monitors).set({ failingSince: Date.now() - 6 * 60_000 }).where(eq(monitors.id, monitor.id))
    await recordObservation(await reload(monitor.id), down)
    await resolveIncidentForRecovery(await reload(monitor.id))
    await resolveIncidentForRecovery(await reload(monitor.id))
    assert.equal((await db.select().from(incidentUpdates)).filter((u) => u.status === 'resolved').length, 1)
  })

  it('starts the outage clock for a monitor that was already down', async () => {
    const monitor = await addMonitor({ alertConfirmedStatus: 'down', currentStatus: 'down' })
    await recordObservation(monitor, down)
    assert.ok((await reload(monitor.id)).failingSince)
  })

  it('does not reopen an incident the operator resolved during the same outage', async () => {
    const monitor = await addMonitor()
    await recordObservation(monitor, down)
    await db.update(monitors).set({ failingSince: Date.now() - 6 * 60_000 }).where(eq(monitors.id, monitor.id))
    await recordObservation(await reload(monitor.id), down)
    await db.update(incidents).set({ status: 'resolved', resolvedAt: Date.now() })
    await recordObservation(await reload(monitor.id), down)
    assert.equal((await db.select().from(incidents)).length, 1)
    // A later, separate outage gets its own incident.
    await recordObservation(await reload(monitor.id), up)
    await recordObservation(await reload(monitor.id), down)
    await db.update(monitors).set({ failingSince: Date.now() - 6 * 60_000 }).where(eq(monitors.id, monitor.id))
    await recordObservation(await reload(monitor.id), down)
    assert.equal((await db.select().from(incidents)).length, 2)
  })

  it('does nothing when the feature is off for the monitor', async () => {
    const monitor = await addMonitor({ autoIncidentMinutes: null })
    await recordObservation(monitor, down)
    await db.update(monitors).set({ failingSince: Date.now() - 60 * 60_000 }).where(eq(monitors.id, monitor.id))
    await recordObservation(await reload(monitor.id), down)
    assert.equal((await db.select().from(incidents)).length, 0)
  })
})

describe('drafts on the public status page', () => {
  const app = Fastify({ logger: false })
  before(async () => {
    await app.register(rateLimit, { global: false })
    await app.register(publicRoutes, { prefix: '/api/v1/public' })
    await app.ready()
  })
  after(async () => { await app.close() })

  it('hides a draft from the incident list, detail and status', async () => {
    const now = Date.now()
    await refreshPublishedMonitorIds()
    const [draft, live] = await db.insert(incidents).values([
      { title: 'Draft one', status: 'investigating', impact: 'major', startedAt: now, createdAt: now, updatedAt: now, draft: 1 },
      { title: 'Live one', status: 'investigating', impact: 'minor', startedAt: now, createdAt: now, updatedAt: now },
    ]).returning()
    const list = (await app.inject({ method: 'GET', url: '/api/v1/public/incidents' })).json() as Array<{ title: string }>
    assert.deepEqual(list.map((i) => i.title), ['Live one'])
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/public/incidents/${draft!.id}` })).statusCode, 404)
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/public/incidents/${live!.id}` })).statusCode, 200)
    const status = (await app.inject({ method: 'GET', url: '/api/v1/public/status' })).json() as { activeIncidents: Array<{ title: string }> }
    assert.deepEqual(status.activeIncidents.map((i) => i.title), ['Live one'])
  })
})
