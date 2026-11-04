import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { db } from '../src/db/client.js'
import { RESULT_IN_MAINTENANCE, RESULT_UNCONFIRMED } from '../src/db/resultMarks.js'
import { monitorResults, monitors } from '../src/db/schema.js'
import { monitorRoutes } from '../src/routes/monitors.js'
import { loadMonitorHealth } from '../src/services/monitorHealth.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'
import { eq } from 'drizzle-orm'

const testDb = createTestDb('bsp-monitor-health-test-')
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

type Health = { uptime24h: number | null; avgResponseMs: number | null; responseTrend: Array<number | null>; failureRunSince: number | null; latencyRatio: number | null }
type Listed = Array<{ id: number; health: Health }>

const MIN = 60_000

describe('monitor health in the list', () => {
  it('reports 24 h uptime, response time, an hourly trend and when a run of failures began', async () => {
    const create = async (name: string) => (await app.inject({
      method: 'POST', url: '/monitors',
      payload: { name, type: 'https', config: { url: 'https://a.example.test', method: 'GET', expectedStatus: 200 } },
    })).json<{ id: number }>().id
    const [steady, failing, empty] = [await create('Steady'), await create('Failing'), await create('Empty')]
    const now = Date.now()
    await db.update(monitors).set({ currentStatus: 'down' }).where(eq(monitors.id, failing))

    const result = (monitorId: number, minutesAgo: number, status: string, responseMs: number | null, unconfirmed = 0) =>
      ({ monitorId, status, responseMs, checkedAt: now - minutesAgo * MIN, errorMessage: null, unconfirmed })
    await db.insert(monitorResults).values([
      // 3 of 4 counted checks pass; the one in maintenance is left out, the unconfirmed failure counts as up.
      result(steady, 10, 'up', 100), result(steady, 20, 'up', 300), result(steady, 30, 'down', null, RESULT_UNCONFIRMED),
      result(steady, 40, 'down', null, RESULT_IN_MAINTENANCE), result(steady, 50, 'down', null),
      // One pass, then the run of failures (the first only unconfirmed) that the status belongs to.
      result(failing, 90, 'up', 50), result(failing, 60, 'down', null, RESULT_UNCONFIRMED), result(failing, 45, 'down', null), result(failing, 15, 'down', null),
      // Older than 24 h: ignored.
      result(steady, 25 * 60, 'down', null),
    ])

    const list = (await app.inject({ method: 'GET', url: '/monitors' })).json<Listed>()
    const of = (id: number) => list.find((m) => m.id === id)!.health

    assert.equal(of(steady).uptime24h, 75)
    assert.equal(of(steady).avgResponseMs, 200)
    assert.equal(of(steady).responseTrend.length, 24)
    assert.equal(of(steady).responseTrend.filter((v) => v !== null).length >= 1, true)
    assert.equal(of(steady).failureRunSince, null)

    assert.equal(of(failing).failureRunSince, now - 60 * MIN, 'the run starts at the first failure after the last passing check')
    assert.equal(of(failing).avgResponseMs, 50)

    assert.deepEqual(of(empty), { uptime24h: null, avgResponseMs: null, responseTrend: Array.from({ length: 24 }, () => null), failureRunSince: null, latencyRatio: null })
  })

  it('reports how many times slower than usual a monitor with an open alert is', async () => {
    const create = async (name: string) => (await app.inject({
      method: 'POST', url: '/monitors',
      payload: { name, type: 'https', config: { url: 'https://a.example.test', method: 'GET', expectedStatus: 200 } },
    })).json<{ id: number }>().id
    const [slow, quiet, sparse] = [await create('Slow'), await create('Quiet'), await create('Sparse')]
    const now = Date.now()
    const alerting = { latencyAlertSince: now - 10 * MIN, latencyBaselineP95: 100, latencyAlertWindowMinutes: 30 }
    await db.update(monitors).set(alerting).where(eq(monitors.id, slow))
    await db.update(monitors).set(alerting).where(eq(monitors.id, sparse))
    // 22 timed checks in the window, all 300 ms: the p95 is 300 against a usual 100.
    const checks = (monitorId: number, count: number) => Array.from({ length: count }, (_, i) =>
      ({ monitorId, status: 'up', responseMs: 300, checkedAt: now - (i + 1) * MIN, errorMessage: null, unconfirmed: 0 }))
    await db.insert(monitorResults).values([...checks(slow, 22), ...checks(quiet, 22), ...checks(sparse, 5)])

    const list = (await app.inject({ method: 'GET', url: '/monitors' })).json<Listed>()
    const of = (id: number) => list.find((m) => m.id === id)!.health.latencyRatio
    assert.equal(of(slow), 3)
    assert.equal(of(quiet), null, 'no open alert')
    assert.equal(of(sparse), null, 'too few checks in the window to judge')
  })

  it('finds the start of a failure run for a degraded monitor and for one that never passed', async () => {
    const create = async (name: string) => (await app.inject({
      method: 'POST', url: '/monitors',
      payload: { name, type: 'https', config: { url: 'https://a.example.test', method: 'GET', expectedStatus: 200 } },
    })).json<{ id: number }>().id
    const [degraded, neverUp, passing] = [await create('Degraded'), await create('Never up'), await create('Passing')]
    const now = Date.now()
    await db.update(monitors).set({ currentStatus: 'degraded' }).where(eq(monitors.id, degraded))
    await db.update(monitors).set({ currentStatus: 'down' }).where(eq(monitors.id, neverUp))
    const result = (monitorId: number, minutesAgo: number, status: string) =>
      ({ monitorId, status, responseMs: 10, checkedAt: now - minutesAgo * MIN, errorMessage: null, unconfirmed: 0 })
    await db.insert(monitorResults).values([
      result(degraded, 120, 'up'), result(degraded, 40, 'degraded'), result(degraded, 20, 'degraded'),
      result(neverUp, 300, 'down'), result(neverUp, 100, 'down'), result(neverUp, 5, 'down'),
      result(passing, 30, 'up'),
    ])

    const list = (await app.inject({ method: 'GET', url: '/monitors' })).json<Listed>()
    const of = (id: number) => list.find((m) => m.id === id)!.health.failureRunSince
    assert.equal(of(degraded), now - 40 * MIN)
    assert.equal(of(neverUp), now - 300 * MIN, 'no passing check at all: the run starts at the oldest result')
    assert.equal(of(passing), null)
  })

  it('has no ratio for an open alert without a baseline, and merges a check at exactly now into the last hour', async () => {
    const now = Date.now()
    const create = async (name: string) => (await app.inject({
      method: 'POST', url: '/monitors',
      payload: { name, type: 'https', config: { url: 'https://a.example.test', method: 'GET', expectedStatus: 200 } },
    })).json<{ id: number }>().id
    const id = await create('Edge')
    await db.update(monitors).set({ latencyAlertSince: now - MIN, latencyBaselineP95: null }).where(eq(monitors.id, id))
    await db.insert(monitorResults).values([
      { monitorId: id, status: 'up', responseMs: 200, checkedAt: now - 30 * MIN, errorMessage: null, unconfirmed: 0 },
      { monitorId: id, status: 'up', responseMs: 400, checkedAt: now, errorMessage: null, unconfirmed: 0 },
    ])
    const [row] = await db.select().from(monitors).where(eq(monitors.id, id))
    const health = (await loadMonitorHealth([row!], now))(id)

    assert.equal(health.latencyRatio, null)
    assert.equal(health.responseTrend[23], 300, 'both checks are averaged in the last hour')
    assert.equal(health.avgResponseMs, 300)
  })
})
