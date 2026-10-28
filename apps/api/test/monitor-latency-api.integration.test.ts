import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { monitorResults, monitors } from '../src/db/schema.js'
import { monitorRoutes } from '../src/routes/monitors.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const testDb = createTestDb('bsp-monitor-latency-api-')
const app = Fastify({ logger: false })

before(async () => {
  initTestDb()
  app.addHook('preHandler', async (request) => {
    request.user = { userId: 1, email: 'admin@example.test', role: 'admin' }
  })
  await app.register(monitorRoutes, { prefix: '/monitors' })
  await app.ready()
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

beforeEach(async () => {
  await db.delete(monitorResults)
  await db.delete(monitors)
})

const body = (patch: Record<string, unknown> = {}) => ({ name: 'Site', type: 'https', config: { url: 'https://example.test', method: 'GET', expectedStatus: 200 }, ...patch })
const create = async (patch: Record<string, unknown> = {}) => (await app.inject({ method: 'POST', url: '/monitors', payload: body(patch) })).json()
const patch = (id: number, payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/monitors/${id}`, payload })
const row = async (id: number) => (await db.select().from(monitors).where(eq(monitors.id, id)))[0]!

describe('slower-than-usual alert settings of a monitor', () => {
  it('is off for a new monitor and carries the default settings', async () => {
    const created = await create()
    assert.equal(created.latencyAlertFactor, null)
    assert.equal(created.latencyAlertWindowMinutes, 30)
    assert.equal(created.latencyAlertMinDeltaMs, 200)
    assert.equal(created.latencyAlertSustain, 3)
    assert.equal(created.latencyAlertSince, null)
  })

  it('stores the settings of a new monitor, rounding the factor to one decimal', async () => {
    const created = await create({ latencyAlertFactor: 2.46, latencyAlertWindowMinutes: 60, latencyAlertMinDeltaMs: 50, latencyAlertSustain: 5 })
    assert.equal(created.latencyAlertFactor, 2.5)
    assert.equal(created.latencyAlertWindowMinutes, 60)
    assert.equal(created.latencyAlertMinDeltaMs, 50)
    assert.equal(created.latencyAlertSustain, 5)
  })

  it('refuses values out of range', async () => {
    for (const [field, value] of [
      ['latencyAlertFactor', 1.2], ['latencyAlertFactor', 11], ['latencyAlertFactor', '3'],
      ['latencyAlertWindowMinutes', 9], ['latencyAlertWindowMinutes', 241], ['latencyAlertWindowMinutes', 30.5],
      ['latencyAlertMinDeltaMs', -1], ['latencyAlertMinDeltaMs', 60_001],
      ['latencyAlertSustain', 0], ['latencyAlertSustain', 21],
    ] as const) {
      const response = await app.inject({ method: 'POST', url: '/monitors', payload: body({ [field]: value }) })
      assert.equal(response.statusCode, 400, `${field}=${String(value)}`)
      assert.match(response.json().error, new RegExp(field))
    }
  })

  it('refuses the alert for the types whose response time is not the time a service took to answer', async () => {
    const configs: Record<string, unknown> = {
      domain: { domain: 'example.com', warnDays: 30 }, tls: { host: 'example.com', port: 443, warnDays: 21 }, docker: { endpoint: 'http://docker.local:2375', container: 'web' }, webhook: {},
    }
    for (const [type, config] of Object.entries(configs)) {
      const response = await app.inject({ method: 'POST', url: '/monitors', payload: body({ type, config, latencyAlertFactor: 3 }) })
      assert.equal(response.statusCode, 400, type)
      assert.match(response.json().error, /not available for/)
      // Without the alert the same monitor is fine.
      assert.equal((await app.inject({ method: 'POST', url: '/monitors', payload: body({ type, config }) })).statusCode, 200, type)
    }
    const ping = await app.inject({ method: 'POST', url: '/monitors', payload: body({ type: 'ping', config: { host: 'example.test', mode: 'tcp' }, latencyAlertFactor: 3 }) })
    assert.equal(ping.statusCode, 200)
  })

  it('turns the alert off when a monitor is moved to such a type, and refuses to turn it on there', async () => {
    const created = await create({ latencyAlertFactor: 3 })
    assert.equal((await patch(created.id, { latencyAlertFactor: 3, type: 'domain', config: { domain: 'example.com', warnDays: 30 } })).statusCode, 400)
    assert.equal((await patch(created.id, { type: 'domain', config: { domain: 'example.com', warnDays: 30 } })).statusCode, 200)
    assert.equal((await row(created.id)).latencyAlertFactor, null)
    assert.equal((await patch(created.id, { latencyAlertFactor: 3 })).statusCode, 400)
  })

  it('turns off with null and leaves the settings alone when they are not sent', async () => {
    const created = await create({ latencyAlertFactor: 3, latencyAlertSustain: 4 })
    assert.equal((await patch(created.id, { name: 'Renamed' })).statusCode, 200)
    assert.equal((await row(created.id)).latencyAlertFactor, 3)
    assert.equal((await row(created.id)).latencyAlertSustain, 4)
    assert.equal((await patch(created.id, { latencyAlertFactor: null })).statusCode, 200)
    assert.equal((await row(created.id)).latencyAlertFactor, null)
  })

  it('closes an open alert when a setting changes, not when the same values are saved again', async () => {
    const created = await create({ latencyAlertFactor: 3 })
    await db.update(monitors).set({ latencyAlertSince: 5, latencyAlertCount: 2, latencyBaselineAt: 7 }).where(eq(monitors.id, created.id))

    await patch(created.id, { name: 'Renamed', latencyAlertFactor: 3, latencyAlertWindowMinutes: 30, latencyAlertMinDeltaMs: 200, latencyAlertSustain: 3 })
    const kept = await row(created.id)
    assert.deepEqual([kept.latencyAlertSince, kept.latencyAlertCount, kept.latencyBaselineAt], [5, 2, 7])

    await patch(created.id, { latencyAlertFactor: 4 })
    const closed = await row(created.id)
    assert.deepEqual([closed.latencyAlertSince, closed.latencyAlertCount, closed.latencyBaselineAt], [null, 0, null])
  })
})

describe('what else closes an open slower-than-usual alert', () => {
  const open = async () => {
    const created = await create({ latencyAlertFactor: 3 })
    await db.update(monitors).set({ latencyAlertSince: 5, latencyAlertCount: 2, latencyBaselineAt: 7 }).where(eq(monitors.id, created.id))
    return created.id as number
  }

  it('closes it when the check interval changes, since the window may no longer hold enough checks', async () => {
    const id = await open()
    await patch(id, { intervalSecs: 60 })
    assert.equal((await row(id)).latencyAlertSince, 5)
    await patch(id, { intervalSecs: 300 })
    assert.equal((await row(id)).latencyAlertSince, null)
  })

  it('closes it when the type changes', async () => {
    const id = await open()
    await patch(id, { type: 'ping', config: { host: 'example.test', mode: 'tcp' } })
    assert.equal((await row(id)).latencyAlertSince, null)
  })
})

describe('baseline in the statistics of a monitor', () => {
  const seed = async (id: number, from: number, to: number, ms: number) => {
    const rows: Array<typeof monitorResults.$inferInsert> = []
    for (let at = from; at < to; at += 10 * MINUTE) rows.push({ monitorId: id, status: 'up', responseMs: ms, checkedAt: at })
    for (let i = 0; i < rows.length; i += 400) await db.insert(monitorResults).values(rows.slice(i, i + 400))
  }

  it('is null while the history is too short', async () => {
    const created = await create()
    const now = Date.now()
    await seed(created.id, now - 5 * 60 * MINUTE, now - 40 * MINUTE, 150)
    const stats = (await app.inject({ url: `/monitors/${created.id}/stats?hours=24` })).json()
    assert.equal(stats.baselineP95Ms, null)
  })

  it('is the p95 of the previous seven days, before any alert is on', async () => {
    const created = await create()
    const now = Date.now()
    await seed(created.id, now - 3 * DAY, now - 40 * MINUTE, 150)
    const stats = (await app.inject({ url: `/monitors/${created.id}/stats?hours=24` })).json()
    assert.equal(stats.baselineP95Ms, 150)
  })

  it('is the frozen one while an alert is open', async () => {
    const created = await create({ latencyAlertFactor: 3 })
    const now = Date.now()
    await seed(created.id, now - 3 * DAY, now - 40 * MINUTE, 900)
    await db.update(monitors).set({ latencyAlertSince: now - 10 * MINUTE, latencyBaselineP95: 150, latencyBaselineAt: now - MINUTE }).where(eq(monitors.id, created.id))
    const stats = (await app.inject({ url: `/monitors/${created.id}/stats?hours=24` })).json()
    assert.equal(stats.baselineP95Ms, 150)
  })
})
