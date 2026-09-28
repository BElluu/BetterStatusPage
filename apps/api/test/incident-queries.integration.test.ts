import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { db } from '../src/db/client.js'
import { branding, incidentMonitors, incidents, layout, monitorDependencies, monitorResults, monitors } from '../src/db/schema.js'
import { auditRoutes } from '../src/routes/audit.js'
import { incidentRoutes } from '../src/routes/incidents.js'
import { monitorRoutes } from '../src/routes/monitors.js'
import { publicRoutes } from '../src/routes/public.js'
import { parsePagination, parseStrictPagination } from '../src/lib/pagination.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'
import { eq } from 'drizzle-orm'

const testDb = createTestDb('bsp-incident-queries-test-')

const app = Fastify({ logger: false })
let publicId = 0
let internalId = 0
let thresholdId = 0

async function addMonitor(name: string): Promise<number> {
  const now = Date.now()
  const rows = await db.insert(monitors).values({ name, type: 'webhook', config: '{}', createdAt: now, updatedAt: now }).returning()
  return rows[0]!.id
}

before(async () => {
  initTestDb()
  publicId = await addMonitor('Website')
  internalId = await addMonitor('Internal DB')
  thresholdId = await addMonitor('Threshold monitor')
  await db.insert(layout).values({
    id: 1,
    tree: JSON.stringify({ id: 'root', type: 'page', children: [{ id: 'm1', type: 'monitor', monitorId: publicId }, { id: 'm2', type: 'monitor', monitorId: thresholdId }] }),
    updatedAt: Date.now(),
  })

  await app.register(rateLimit, { global: false })
  await app.register(async (admin) => {
    admin.addHook('preHandler', async (request) => {
      request.user = { userId: 1, email: 'admin@example.test', role: 'admin' }
    })
    await admin.register(incidentRoutes, { prefix: '/incidents' })
    await admin.register(monitorRoutes, { prefix: '/monitors' })
    await admin.register(auditRoutes, { prefix: '/audit' })
  })
  await app.register(publicRoutes, { prefix: '/public' })
  await app.ready()
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

async function createIncident(payload: Record<string, unknown>) {
  const response = await app.inject({ method: 'POST', url: '/incidents', payload: { notifySubscribers: false, ...payload } })
  assert.equal(response.statusCode, 200)
  return response.json() as { id: number; status: string; resolvedAt: number | null; monitorIds: number[] }
}

async function postUpdate(id: number, body: string, status: string) {
  const response = await app.inject({ method: 'POST', url: `/incidents/${id}/updates`, payload: { body, status, notifySubscribers: false } })
  assert.equal(response.statusCode, 200)
}

async function storedIncident(id: number) {
  return (await db.select().from(incidents).where(eq(incidents.id, id)))[0]!
}

describe('incident lists load details in batches', () => {
  it('returns each incident with its own updates (newest first) and monitor links', async () => {
    const first = await createIncident({ title: 'First', monitorIds: [publicId] })
    const second = await createIncident({ title: 'Second', monitorIds: [publicId, internalId] })
    const third = await createIncident({ title: 'Third' })
    await postUpdate(first.id, 'first-a', 'identified')
    await postUpdate(second.id, 'second-a', 'identified')
    await postUpdate(first.id, 'first-b', 'monitoring')

    const list = (await app.inject({ url: '/incidents' })).json() as Array<{ id: number; title: string; updates: Array<{ body: string; incidentId: number }>; monitorIds: number[] }>
    const byId = new Map(list.map((incident) => [incident.id, incident]))
    assert.deepEqual(byId.get(first.id)!.updates.map((u) => u.body), ['first-b', 'first-a'])
    assert.deepEqual(byId.get(second.id)!.updates.map((u) => u.body), ['second-a'])
    assert.deepEqual(byId.get(third.id)!.updates, [])
    assert.deepEqual(byId.get(first.id)!.monitorIds, [publicId])
    assert.deepEqual([...byId.get(second.id)!.monitorIds].sort(), [publicId, internalId].sort())
    assert.deepEqual(byId.get(third.id)!.monitorIds, [])
    // Newest first, as before.
    assert.deepEqual(list.slice(0, 3).map((incident) => incident.title), ['Third', 'Second', 'First'])
  })

  it('keeps returning the whole list without paging parameters and pages on request', async () => {
    const all = (await app.inject({ url: '/incidents' })).json() as Array<{ id: number }>
    assert.ok(all.length >= 3)
    const page = (await app.inject({ url: '/incidents?limit=2&page=2' })).json() as Array<{ id: number }>
    assert.deepEqual(page.map((incident) => incident.id), all.slice(2, 4).map((incident) => incident.id))
  })

  it('serves the same details publicly, without links to internal monitors', async () => {
    const response = await app.inject({ url: '/public/incidents?limit=100' })
    assert.equal(response.statusCode, 200)
    const list = response.json() as Array<{ title: string; updates: Array<{ body: string }>; monitorIds: number[] }>
    const second = list.find((incident) => incident.title === 'Second')!
    assert.deepEqual(second.monitorIds, [publicId])
    assert.deepEqual(second.updates.map((u) => u.body), ['second-a'])
    assert.deepEqual(list.find((incident) => incident.title === 'First')!.updates.map((u) => u.body), ['first-b', 'first-a'])

    const status = (await app.inject({ url: '/public/status' })).json() as { activeIncidents: Array<{ title: string; monitorIds: number[] }> }
    assert.deepEqual(status.activeIncidents.find((incident) => incident.title === 'Second')!.monitorIds, [publicId])
    assert.equal((await app.inject({ url: '/public/incidents?page=0' })).statusCode, 400)
    assert.equal((await app.inject({ url: '/public/incidents?limit=abc' })).statusCode, 400)
  })
})

describe('incident resolvedAt follows the status', () => {
  it('is set when created resolved and cleared when reopened', async () => {
    const incident = await createIncident({ title: 'Born resolved', status: 'resolved' })
    assert.equal(typeof incident.resolvedAt, 'number')

    const reopened = await app.inject({ method: 'PATCH', url: `/incidents/${incident.id}`, payload: { status: 'investigating', notifySubscribers: false } })
    assert.equal(reopened.statusCode, 200)
    assert.equal(reopened.json().resolvedAt, null)
  })

  it('is stamped by PATCH status=resolved and kept on later resolved edits', async () => {
    const incident = await createIncident({ title: 'Patched' })
    assert.equal(incident.resolvedAt, null)
    const resolved = await app.inject({ method: 'PATCH', url: `/incidents/${incident.id}`, payload: { status: 'resolved', notifySubscribers: false } })
    const resolvedAt = resolved.json().resolvedAt as number
    assert.equal(typeof resolvedAt, 'number')

    await app.inject({ method: 'PATCH', url: `/incidents/${incident.id}`, payload: { title: 'Patched again' } })
    assert.equal((await storedIncident(incident.id)).resolvedAt, resolvedAt)
    await postUpdate(incident.id, 'Still fine', 'resolved')
    assert.equal((await storedIncident(incident.id)).resolvedAt, resolvedAt)

    // An explicit time is honoured only for a resolved incident.
    await app.inject({ method: 'PATCH', url: `/incidents/${incident.id}`, payload: { resolvedAt: 1_000 } })
    assert.equal((await storedIncident(incident.id)).resolvedAt, 1_000)
    await app.inject({ method: 'PATCH', url: `/incidents/${incident.id}`, payload: { status: 'monitoring', resolvedAt: 2_000, notifySubscribers: false } })
    assert.equal((await storedIncident(incident.id)).resolvedAt, null)
    const invalid = await app.inject({ method: 'PATCH', url: `/incidents/${incident.id}`, payload: { resolvedAt: 'soon' } })
    assert.equal(invalid.statusCode, 400)
  })

  it('is cleared by a timeline update that reopens the incident and restamped when it resolves again', async () => {
    const incident = await createIncident({ title: 'Flapping' })
    await postUpdate(incident.id, 'Fixed', 'resolved')
    assert.equal(typeof (await storedIncident(incident.id)).resolvedAt, 'number')
    await postUpdate(incident.id, 'Back again', 'investigating')
    assert.equal((await storedIncident(incident.id)).resolvedAt, null)
    await postUpdate(incident.id, 'Fixed for good', 'resolved')
    assert.equal(typeof (await storedIncident(incident.id)).resolvedAt, 'number')
  })
})

describe('incident monitor relinking', () => {
  async function links(incidentId: number) {
    return (await db.select().from(incidentMonitors).where(eq(incidentMonitors.incidentId, incidentId))).map((l) => l.monitorId).sort()
  }

  it('rejects an invalid list without touching the existing links', async () => {
    const incident = await createIncident({ title: 'Relink', monitorIds: [publicId] })
    for (const monitorIds of [[publicId, 'x'], 'nope', [0], undefined]) {
      const response = await app.inject({ method: 'POST', url: `/incidents/${incident.id}/monitors`, payload: monitorIds === undefined ? {} : { monitorIds } })
      assert.equal(response.statusCode, 400, JSON.stringify(monitorIds))
    }
    assert.deepEqual(await links(incident.id), [publicId])
  })

  it('dedupes, drops unknown monitors and replaces the links', async () => {
    const incident = await createIncident({ title: 'Relink ok', monitorIds: [publicId] })
    const response = await app.inject({
      method: 'POST', url: `/incidents/${incident.id}/monitors`, payload: { monitorIds: [internalId, internalId, 999_999] },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().monitorIds, [internalId])
    assert.deepEqual(await links(incident.id), [internalId])
  })
})

describe('monitor dependency cycles', () => {
  it('rejects direct and transitive cycles and keeps the previous dependencies', async () => {
    const a = await addMonitor('A')
    const b = await addMonitor('B')
    const c = await addMonitor('C')
    const put = (id: number, dependsOnIds: unknown) => app.inject({ method: 'PUT', url: `/monitors/${id}/dependencies`, payload: { dependsOnIds } })

    assert.equal((await put(a, [b])).statusCode, 200)
    const direct = await put(b, [a])
    assert.equal(direct.statusCode, 400)
    assert.match(direct.json().error, /cycle/i)

    assert.equal((await put(b, [c])).statusCode, 200)
    assert.equal((await put(c, [a])).statusCode, 400)
    assert.equal((await put(c, [b, a])).statusCode, 400)

    // Replacing A's own edges is not a cycle: A no longer depends on B afterwards.
    assert.equal((await put(a, [c])).statusCode, 200)
    const edges = (await db.select().from(monitorDependencies)).filter((edge) => [a, b, c].includes(edge.dependentId))
      .map((edge) => `${edge.dependentId}->${edge.dependsOnId}`).sort()
    assert.deepEqual(edges, [`${a}->${c}`, `${b}->${c}`].sort())

    assert.equal((await put(a, 'nope')).statusCode, 400)
    assert.deepEqual((await app.inject({ url: `/monitors/${a}/dependencies` })).json(), { dependsOnIds: [c] })
  })
})

describe('public uptime', () => {
  it('counts checks per day and caches the result briefly', async () => {
    const now = Date.now()
    await db.insert(monitorResults).values([
      { monitorId: publicId, status: 'up', checkedAt: now - 1_000 },
      { monitorId: publicId, status: 'down', checkedAt: now - 2_000 },
      { monitorId: publicId, status: 'up', checkedAt: now - 3_000 },
    ])
    const first = await app.inject({ url: `/public/monitor/${publicId}/uptime?days=2` })
    assert.equal(first.statusCode, 200)
    const body = first.json() as { monitorId: number; days: Array<Record<string, unknown>>; overallUptimePct: number }
    assert.equal(body.days.length, 2)
    const today = body.days[1]!
    assert.deepEqual(Object.keys(today).sort(), ['checksTotal', 'checksUp', 'date', 'incidents', 'status', 'uptimePct'])
    assert.equal(today['date'], new Date(now).toISOString().slice(0, 10))
    assert.equal(today['checksTotal'], 3)
    assert.equal(today['checksUp'], 2)
    // 66.7% is below the default partial-outage threshold (95%).
    assert.equal(today['status'], 'down')
    assert.ok(Math.abs(body.overallUptimePct - 200 / 3) < 1e-9)

    await db.insert(monitorResults).values({ monitorId: publicId, status: 'down', checkedAt: now - 500 })
    const cached = (await app.inject({ url: `/public/monitor/${publicId}/uptime?days=2` })).json()
    assert.equal(cached.days[1].checksTotal, 3)
    // A different window is a different cache entry.
    assert.equal((await app.inject({ url: `/public/monitor/${publicId}/uptime?days=1` })).json().days[0].checksTotal, 4)
  })
})

describe('public uptime thresholds', () => {
  it('colours days by the configured thresholds and ignores unconfirmed failures', async () => {
    const monitorId = thresholdId
    const now = Date.now()
    const results = Array.from({ length: 100 }, (_, i) => ({
      monitorId, status: i < 2 ? 'down' : 'up', checkedAt: now - 1_000 - i,
    }))
    // An unconfirmed blip is stored as a failure but must not lower uptime.
    results.push({ monitorId, status: 'down', checkedAt: now - 5_000, unconfirmed: 1 } as typeof results[number])
    await db.insert(monitorResults).values(results)

    await db.insert(branding).values({ id: 1, updatedAt: now, uptimeThresholdUp: 99.9, uptimeThresholdDegraded: 98, uptimeThresholdPartial: 90 })
      .onConflictDoUpdate({ target: branding.id, set: { uptimeThresholdUp: 99.9, uptimeThresholdDegraded: 98, uptimeThresholdPartial: 90 } })
    const body = (await app.inject({ url: `/public/monitor/${monitorId}/uptime?days=1` })).json()
    const today = body.days[0]
    assert.equal(today.checksTotal, 101)
    assert.equal(today.checksUp, 99)
    assert.equal(today.status, 'degraded') // 98.02% ≥ 98
  })
})

describe('audit paging', () => {
  it('falls back to defaults for non-numeric values instead of a NaN offset', async () => {
    const response = await app.inject({ url: '/audit?page=abc&limit=xyz' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().page, 1)
    assert.equal(response.json().limit, 50)
    const clamped = (await app.inject({ url: '/audit?page=-3&limit=9999' })).json()
    assert.equal(clamped.page, 1)
    assert.equal(clamped.limit, 100)
  })
})

describe('pagination helpers', () => {
  const options = { defaultLimit: 25, maxLimit: 100 }

  it('clamps lenient paging', () => {
    assert.deepEqual(parsePagination({}, options), { page: 1, limit: 25, offset: 0 })
    assert.deepEqual(parsePagination({ page: '3', limit: '10' }, options), { page: 3, limit: 10, offset: 20 })
    assert.deepEqual(parsePagination({ page: 'abc', limit: 'xyz' }, options), { page: 1, limit: 25, offset: 0 })
    assert.deepEqual(parsePagination({ page: '0', limit: '500' }, options), { page: 1, limit: 100, offset: 0 })
    assert.deepEqual(parsePagination({ page: '2.7', limit: '-5' }, options), { page: 2, limit: 1, offset: 1 })
    assert.equal(parsePagination({ page: '1e12' }, options).page, 100_000)
  })

  it('rejects out-of-range strict paging', () => {
    assert.deepEqual(parseStrictPagination({}, options), { page: 1, limit: 25, offset: 0 })
    assert.deepEqual(parseStrictPagination({ page: '2', limit: '100' }, options), { page: 2, limit: 100, offset: 100 })
    for (const query of [{ page: '0' }, { limit: '101' }, { page: 'abc' }, { limit: '1.5' }, { page: '' }]) {
      assert.equal(parseStrictPagination(query, options), null, JSON.stringify(query))
    }
  })
})
