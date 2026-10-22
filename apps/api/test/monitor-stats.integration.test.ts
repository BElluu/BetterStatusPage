import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { db, sqlite } from '../src/db/client.js'
import { incidentMonitors, incidents, monitorResults, monitors } from '../src/db/schema.js'
import { monitorRoutes } from '../src/routes/monitors.js'
import type { MonitorStats } from '@bsp/shared'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-monitor-stats-test-')
const app = Fastify({ logger: false })
const HOUR = 3_600_000

let monitorId = 0
let emptyId = 0

before(async () => {
  initTestDb()
  const now = Date.now()
  const base = { type: 'https', config: '{}', createdAt: now, updatedAt: now }
  monitorId = (await db.insert(monitors).values({ ...base, name: 'Alpha' }).returning())[0]!.id
  emptyId = (await db.insert(monitors).values({ ...base, name: 'Empty' }).returning())[0]!.id

  const row = (agoMs: number, status: string, responseMs: number | null, extra: { unconfirmed?: number; errorMessage?: string } = {}) =>
    ({ monitorId, status, responseMs, checkedAt: now - agoMs, ...extra })
  await db.insert(monitorResults).values([
    row(1 * HOUR, 'up', 100),
    row(2 * HOUR, 'up', 200),
    row(3 * HOUR, 'up', 300),
    row(4 * HOUR, 'up', 400),
    row(5 * HOUR, 'down', null, { errorMessage: 'connect ECONNREFUSED' }),
    row(6 * HOUR, 'down', null, { unconfirmed: 1 }), // does not lower uptime and is not a confirmed failure
    row(30 * HOUR, 'up', 1000), // outside a 24h window
  ])

  const [resolved] = await db.insert(incidents).values({
    title: 'Outage', status: 'resolved', impact: 'major', startedAt: now - 5 * HOUR, resolvedAt: now - 4 * HOUR, createdAt: now, updatedAt: now,
  }).returning()
  const [open] = await db.insert(incidents).values({
    title: 'Ongoing', status: 'investigating', impact: 'minor', startedAt: now - 2 * HOUR, resolvedAt: null, createdAt: now, updatedAt: now,
  }).returning()
  await db.insert(incidentMonitors).values([
    { incidentId: resolved!.id, monitorId },
    { incidentId: open!.id, monitorId },
  ])

  await app.register(monitorRoutes, { prefix: '/monitors' })
  await app.ready()
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

const get = (id: number, query = '') => app.inject({ method: 'GET', url: `/monitors/${id}/stats${query}` })

describe('monitor stats', () => {
  it('summarises uptime, response times, incidents and failures of the window', async () => {
    const response = await get(monitorId, '?hours=24')
    assert.equal(response.statusCode, 200, response.body)
    const stats = response.json<MonitorStats>()
    assert.equal(stats.hours, 24)
    assert.equal(stats.retentionDays, 90)
    assert.equal(stats.checksTotal, 6)
    assert.equal(stats.checksUp, 5)
    assert.ok(Math.abs(stats.uptimePct! - (5 / 6) * 100) < 1e-9)
    assert.equal(stats.failures, 1)
    assert.deepEqual(stats.response, { avg: 250, min: 100, max: 400, p50: 300, p95: 400, p99: 400 })
    assert.equal(stats.buckets.length, 24)
    assert.equal(stats.buckets.reduce((sum, b) => sum + b.down, 0), 1)
    assert.ok(stats.buckets.some((b) => b.p95Ms === 400))
    assert.equal(stats.buckets.reduce((sum, b) => sum + b.checksTotal, 0), 6)
    assert.equal(stats.uptime.stepHours, 1)
    assert.equal(stats.uptime.bars.length, 24)
    assert.equal(stats.uptime.bars.reduce((sum, b) => sum + b.checksTotal, 0), 6)
    assert.equal(stats.incidents.total, 2)
    assert.equal(stats.incidents.mttrMs, HOUR)
    assert.deepEqual(stats.incidents.recent.map((i) => i.title), ['Ongoing', 'Outage'])
    assert.deepEqual(stats.recentFailures.map((f) => [f.errorMessage, f.unconfirmed]), [['connect ECONNREFUSED', false], [null, true]])
  })

  it('lists the ten latest failures only', async () => {
    const now = Date.now()
    await db.insert(monitorResults).values(Array.from({ length: 12 }, (_, i) => ({ monitorId: emptyId, status: 'down', responseMs: null, checkedAt: now - (i + 1) * 60_000 })))
    const stats = (await get(emptyId, '?hours=24')).json<MonitorStats>()
    assert.equal(stats.recentFailures.length, 10)
    assert.equal(stats.recentFailures[0]!.checkedAt, now - 60_000)
    await db.delete(monitorResults).where(eq(monitorResults.monitorId, emptyId))
  })

  it('includes older results in a longer window and clamps it to the retention period', async () => {
    const week = (await get(monitorId)).json<MonitorStats>()
    assert.equal(week.hours, 168)
    assert.equal(week.checksTotal, 7)
    assert.equal(week.uptime.stepHours, 6)
    assert.equal(week.uptime.bars.length, 28)
    const month = (await get(monitorId, '?hours=720')).json<MonitorStats>()
    assert.equal(month.uptime.stepHours, 24)
    assert.equal(month.uptime.bars.length, 30)
    const clamped = (await get(monitorId, '?hours=999999')).json<MonitorStats>()
    assert.equal(clamped.hours, 90 * 24)
  })

  it('returns empty statistics for a monitor without results', async () => {
    const stats = (await get(emptyId, '?hours=24')).json<MonitorStats>()
    assert.equal(stats.checksTotal, 0)
    assert.equal(stats.uptimePct, null)
    assert.equal(stats.response, null)
    assert.equal(stats.incidents.mttrMs, null)
    assert.deepEqual(stats.recentFailures, [])
  })

  it('gives the percentiles the database would, for many results with ties and gaps', async () => {
    const [busy] = await db.insert(monitors).values({ name: 'Busy', type: 'https', config: '{}', createdAt: Date.now(), updatedAt: Date.now() }).returning()
    const now = Date.now()
    let seed = 7
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
    await db.insert(monitorResults).values(Array.from({ length: 3_001 }, (_, i) => ({
      monitorId: busy!.id, status: 'up', checkedAt: now - 1000 - i * 60_000,
      responseMs: next() < 0.15 ? null : Math.floor(next() * 40) * 10, // many equal values
    })))

    const stats = (await get(busy!.id, '?hours=72')).json() as MonitorStats
    // The way the percentiles were read before: the value at an offset of the sorted response times.
    const atOffset = (fraction: number) => {
      const timed = (sqlite.prepare('SELECT count(response_ms) AS n FROM monitor_results WHERE monitor_id = ? AND checked_at >= ?').get(busy!.id, stats.from) as { n: number }).n
      const offset = Math.min(timed - 1, Math.floor(timed * fraction))
      return (sqlite.prepare('SELECT response_ms AS ms FROM monitor_results WHERE monitor_id = ? AND checked_at >= ? AND response_ms IS NOT NULL ORDER BY response_ms LIMIT 1 OFFSET ?').get(busy!.id, stats.from, offset) as { ms: number }).ms
    }
    assert.ok(stats.response && stats.response.max > stats.response.min)
    assert.deepEqual([stats.response.p50, stats.response.p95, stats.response.p99], [atOffset(0.5), atOffset(0.95), atOffset(0.99)])
  })

  it('rejects a bad window and an unknown monitor', async () => {
    assert.equal((await get(monitorId, '?hours=0')).statusCode, 400)
    assert.equal((await get(monitorId, '?hours=abc')).statusCode, 400)
    assert.equal((await get(99999)).statusCode, 404)
  })
})
