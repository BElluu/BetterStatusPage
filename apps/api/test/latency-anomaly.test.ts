import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, beforeEach, describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import type { LatencyAlertSettings } from '@bsp/shared'
import { db } from '../src/db/client.js'
import { monitorNotificationChannels, monitorResults, monitors, notificationChannels, notificationDeliveries, notificationDeliveryAttempts } from '../src/db/schema.js'
import { baselineOf, checkLatency, evaluateLatency, measureBaseline, MIN_WINDOW_SAMPLES, type LatencyState } from '../src/workers/latencyAnomaly.js'
import { digestOf, noticeFromVars } from '../src/workers/notice.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const testDb = createTestDb('bsp-latency-test-')
const server = createServer((request, response) => {
  request.resume()
  request.on('end', () => response.writeHead(204).end())
})
let baseUrl = ''

before(async () => {
  initTestDb()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

beforeEach(async () => {
  await db.delete(notificationDeliveryAttempts)
  await db.delete(notificationDeliveries)
  await db.delete(monitorNotificationChannels)
  await db.delete(notificationChannels)
  await db.delete(monitorResults)
  await db.delete(monitors)
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  teardownTestDb(testDb)
})

const settings: LatencyAlertSettings = { factor: 3, windowMinutes: 30, minDeltaMs: 200, sustain: 3 }
const idle: LatencyState = { since: null, count: 0 }
const window = (value: number, count = 30) => Array.from({ length: count }, () => value)

describe('evaluateLatency', () => {
  it('says nothing while the window holds too few checks', () => {
    const outcome = evaluateLatency({ samples: window(5000, MIN_WINDOW_SAMPLES - 1), baselineMs: 100, settings, state: idle, now: 1 })
    assert.deepEqual(outcome, { event: null, state: idle, p95Ms: null })
  })

  it('is not moved by a single slow check', () => {
    const samples = [...window(150, 29), 9000]
    const outcome = evaluateLatency({ samples, baselineMs: 150, settings, state: { since: null, count: 2 }, now: 1 })
    assert.equal(outcome.event, null)
    assert.equal(outcome.state.count, 0)
  })

  it('counts consecutive slow windows and alerts on the last one needed', () => {
    let state = idle
    const slow = window(700)
    for (const expected of [null, null, 'alert'] as const) {
      const outcome = evaluateLatency({ samples: slow, baselineMs: 200, settings, state, now: 5000 })
      assert.equal(outcome.event, expected)
      state = outcome.state
    }
    assert.deepEqual(state, { since: 5000, count: 0 })
  })

  it('does not alert when the p95 is a high multiple but a small rise', () => {
    const outcome = evaluateLatency({ samples: window(50), baselineMs: 15, settings, state: { since: null, count: 2 }, now: 1 })
    assert.equal(outcome.event, null)
  })

  it('starts counting again after a window that is not slow', () => {
    const slow = evaluateLatency({ samples: window(700), baselineMs: 200, settings, state: { since: null, count: 2 }, now: 1 })
    assert.equal(slow.event, 'alert')
    const calm = evaluateLatency({ samples: window(210), baselineMs: 200, settings, state: { since: null, count: 2 }, now: 1 })
    assert.deepEqual(calm.state, { since: null, count: 0 })
  })

  it('recovers only below the halfway point between the baseline and the limit', () => {
    const open: LatencyState = { since: 1000, count: 0 }
    // limit 600, halfway 400: 450 is still too slow to call it over.
    assert.deepEqual(evaluateLatency({ samples: window(450), baselineMs: 200, settings, state: { since: 1000, count: 2 }, now: 9 }).state, { since: 1000, count: 0 })
    let state = open
    for (const expected of [null, null, 'recovery'] as const) {
      const outcome = evaluateLatency({ samples: window(300), baselineMs: 200, settings, state, now: 9 })
      assert.equal(outcome.event, expected)
      state = outcome.state
    }
    assert.deepEqual(state, { since: null, count: 0 })
  })
})

async function createMonitor(overrides: Partial<typeof monitors.$inferInsert> = {}) {
  const now = Date.now()
  const [monitor] = await db.insert(monitors).values({
    name: 'Checkout', type: 'https', intervalSecs: 60, timeoutMs: 1_000, config: JSON.stringify({ url: 'https://shop.example.test', method: 'GET', expectedStatus: 200 }),
    currentStatus: 'up', latencyAlertFactor: 3, createdAt: now, updatedAt: now, ...overrides,
  }).returning()
  const [channel] = await db.insert(notificationChannels).values({
    name: 'ops', type: 'discord', config: JSON.stringify({ webhookUrl: `${baseUrl}/hook` }), enabled: 1, notifyOnRecovery: 1, createdAt: now, updatedAt: now,
  }).returning()
  await db.insert(monitorNotificationChannels).values({ monitorId: monitor!.id, channelId: channel!.id })
  return monitor!
}

async function addResults(monitorId: number, rows: Array<{ at: number; ms: number | null; status?: string }>) {
  const chunk = 400
  for (let i = 0; i < rows.length; i += chunk) {
    await db.insert(monitorResults).values(rows.slice(i, i + chunk).map((row) => ({
      monitorId, status: row.status ?? 'up', responseMs: row.ms, checkedAt: row.at,
    })))
  }
}

/** Checks every `everyMinutes` from `from` to `to`, all with the same response time. */
const checksBetween = (from: number, to: number, ms: number, everyMinutes = 10) => {
  const rows: Array<{ at: number; ms: number }> = []
  for (let at = from; at < to; at += everyMinutes * MINUTE) rows.push({ at, ms })
  return rows
}

const reload = async (id: number) => (await db.select().from(monitors).where(eq(monitors.id, id)))[0]!
const latencyDeliveries = async () => (await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventType, 'latency'))).sort((a, b) => a.id - b.id)

describe('measureBaseline', () => {
  it('needs a day of history and enough checks', async () => {
    const now = Date.now()
    const monitor = await createMonitor()
    await addResults(monitor.id, checksBetween(now - 6 * 60 * MINUTE, now - 31 * MINUTE, 150, 1))
    assert.equal(await measureBaseline(monitor.id, 30, now), null)

    await addResults(monitor.id, checksBetween(now - 3 * DAY, now - 7 * 60 * MINUTE, 150, 10))
    assert.equal(await measureBaseline(monitor.id, 30, now), 150)
  })

  it('leaves out the judged window, failures and checks without a response time', async () => {
    const now = Date.now()
    const monitor = await createMonitor()
    await addResults(monitor.id, [
      ...checksBetween(now - 3 * DAY, now - 31 * MINUTE, 150, 10),
      ...checksBetween(now - 30 * MINUTE, now, 9000, 1),
      ...checksBetween(now - 2 * DAY, now - 31 * MINUTE, 9000, 10).map((row) => ({ ...row, status: 'down' })),
      { at: now - 2 * DAY, ms: null },
    ])
    assert.equal(await measureBaseline(monitor.id, 30, now), 150)
  })

  it('counts degraded checks: slowness is what is measured', async () => {
    const now = Date.now()
    const monitor = await createMonitor()
    await addResults(monitor.id, checksBetween(now - 3 * DAY, now - 31 * MINUTE, 800, 10).map((row) => ({ ...row, status: 'degraded' })))
    assert.equal(await measureBaseline(monitor.id, 30, now), 800)
  })
})

describe('checkLatency', () => {
  it('alerts after the sustained slowdown, keeps the status and the baseline, and tells when it is over', async () => {
    const now = Date.now()
    const monitor = await createMonitor()
    await addResults(monitor.id, [
      ...checksBetween(now - 3 * DAY, now - 31 * MINUTE, 150, 10),
      ...checksBetween(now - 29 * MINUTE, now + 1, 700, 1),
    ])

    await checkLatency(monitor.id, now)
    await checkLatency(monitor.id, now)
    assert.equal((await latencyDeliveries()).length, 0)
    await checkLatency(monitor.id, now)

    const alerted = await latencyDeliveries()
    assert.equal(alerted.length, 1)
    assert.equal(alerted[0]!.targetStatus, 'latency-slow')
    const variables = JSON.parse(alerted[0]!.variables) as Record<string, string>
    assert.equal(variables['latency_p95_ms'], '700')
    assert.equal(variables['latency_baseline_ms'], '150')
    assert.equal(variables['latency_ratio'], '4.7')

    const open = await reload(monitor.id)
    assert.equal(open.currentStatus, 'up')
    assert.equal(open.latencyAlertSince, now)
    assert.equal(open.latencyBaselineP95, 150)

    // The slowdown goes on for hours: the baseline stays what it was, so the alert does not absorb it.
    const later = now + 6 * 60 * MINUTE
    await addResults(monitor.id, checksBetween(later - 29 * MINUTE, later + 1, 700, 1))
    await checkLatency(monitor.id, later)
    assert.equal((await reload(monitor.id)).latencyBaselineP95, 150)

    const recovered = later + 40 * MINUTE
    await addResults(monitor.id, checksBetween(recovered - 29 * MINUTE, recovered + 1, 160, 1))
    for (let i = 0; i < 3; i++) await checkLatency(monitor.id, recovered)

    const deliveries = await latencyDeliveries()
    assert.deepEqual(deliveries.map((row) => row.targetStatus), ['latency-slow', 'latency-normal'])
    const closed = await reload(monitor.id)
    assert.equal(closed.latencyAlertSince, null)
    assert.equal(closed.latencyBaselineAt, null)
  })

  it('does nothing while the alert is off', async () => {
    const now = Date.now()
    const monitor = await createMonitor({ latencyAlertFactor: null })
    await addResults(monitor.id, [...checksBetween(now - 3 * DAY, now - 31 * MINUTE, 150, 10), ...checksBetween(now - 29 * MINUTE, now + 1, 700, 1)])
    for (let i = 0; i < 4; i++) await checkLatency(monitor.id, now)
    assert.equal((await latencyDeliveries()).length, 0)
    assert.equal((await reload(monitor.id)).latencyBaselineAt, null)
  })

  it('does not scan again on every check while the history is too short for a baseline', async () => {
    const now = Date.now()
    const monitor = await createMonitor()
    await addResults(monitor.id, checksBetween(now - 29 * MINUTE, now + 1, 700, 1))
    await checkLatency(monitor.id, now)
    const first = await reload(monitor.id)
    assert.equal(first.latencyBaselineP95, null)
    assert.equal(first.latencyBaselineAt, now)
    assert.equal((await latencyDeliveries()).length, 0)
  })

  it('starts counting again when the checks are back to normal speed before the alert is confirmed', async () => {
    const now = Date.now()
    const monitor = await createMonitor()
    await addResults(monitor.id, [...checksBetween(now - 3 * DAY, now - 31 * MINUTE, 150, 10), ...checksBetween(now - 29 * MINUTE, now + 1, 700, 1)])
    await checkLatency(monitor.id, now)
    await checkLatency(monitor.id, now)
    const calm = now + 31 * MINUTE
    await addResults(monitor.id, checksBetween(calm - 29 * MINUTE, calm + 1, 150, 1))
    await checkLatency(monitor.id, calm)
    assert.equal((await reload(monitor.id)).latencyAlertCount, 0)
    assert.equal((await latencyDeliveries()).length, 0)
  })
})

describe('evaluateLatency with a small baseline', () => {
  it('ends an alert that the minimum rise decided, even when the p95 settles far above the baseline times the halfway factor', () => {
    // Baseline 40 ms: the limit is 240 ms (the minimum rise), so the halfway point is 140 ms, not 80 ms.
    let state: LatencyState = { since: 1000, count: 0 }
    for (const expected of [null, null, 'recovery'] as const) {
      const outcome = evaluateLatency({ samples: window(120), baselineMs: 40, settings, state, now: 9 })
      assert.equal(outcome.event, expected)
      state = outcome.state
    }
    assert.equal(state.since, null)
  })

  it('does not end it while the p95 is still above the halfway point of the limit', () => {
    const outcome = evaluateLatency({ samples: window(200), baselineMs: 40, settings, state: { since: 1000, count: 2 }, now: 9 })
    assert.equal(outcome.event, null)
    assert.deepEqual(outcome.state, { since: 1000, count: 0 })
  })
})

describe('baselineOf', () => {
  it('measures once an hour and serves the stored figure in between', async () => {
    const now = Date.now()
    const monitor = await createMonitor()
    await addResults(monitor.id, checksBetween(now - 3 * DAY, now - 31 * MINUTE, 150, 10))
    assert.equal(await baselineOf(await reload(monitor.id), now), 150)
    const stored = await reload(monitor.id)
    assert.equal(stored.latencyBaselineP95, 150)
    assert.equal(stored.latencyBaselineAt, now)

    await addResults(monitor.id, checksBetween(now - 3 * DAY + MINUTE, now - 31 * MINUTE, 900, 10))
    assert.equal(await baselineOf(stored, now + 30 * MINUTE), 150)
    assert.equal(await baselineOf(stored, now + 61 * MINUTE) !== 150, true)
  })

  it('does not trust a stored figure from a clock that was ahead', async () => {
    const now = Date.now()
    const monitor = await createMonitor({ latencyBaselineP95: 999, latencyBaselineAt: now + 3 * DAY })
    await addResults(monitor.id, checksBetween(now - 3 * DAY, now - 31 * MINUTE, 150, 10))
    assert.equal(await baselineOf(await reload(monitor.id), now), 150)
  })
})

describe('slower-than-usual digests', () => {
  const row = (sourceName: string, targetStatus: string) => ({ sourceName, targetStatus, previousStatus: 'up', eventType: 'latency', variables: '{}' }) as never

  it('is about a slowdown when one is in it, whatever came first', () => {
    const digest = digestOf([row('A', 'latency-normal'), row('B', 'latency-slow'), row('C', 'latency-slow')], 0)
    assert.equal(digest.vars['status'], 'latency-slow')
    assert.deepEqual(noticeFromVars(digest.vars).severity, 'warning')
  })

  it('words a digest of recoveries without a plural verb after a count', () => {
    const digest = digestOf([row('A', 'latency-normal'), row('B', 'latency-normal')], 0)
    const notice = noticeFromVars(digest.vars)
    assert.equal(notice.severity, 'ok')
    assert.deepEqual(notice.headline, ['Back to normal speed: ', { subject: '2 monitors' }])
  })
})
