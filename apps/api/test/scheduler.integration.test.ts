import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import type { FastifyReply } from 'fastify'
import { webhookRoutes } from '../src/routes/webhook.js'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import {
  maintenanceWindowMonitors, maintenanceWindows, monitorDependencies, monitorResults, monitors,
} from '../src/db/schema.js'
import { sseService } from '../src/kit/sse.js'
import {
  getDueMonitors, getSchedulerHealth, isCheckInFlight, isInMaintenance, purgeOldResults, recordObservation, runCheck, runSchedulerTick,
} from '../src/workers/scheduler.js'
import { loadMonitorStats } from '../src/services/monitorStats.js'
import type { SchedulerConfig } from '../src/config/scheduler.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-scheduler-test-')

let requestCount = 0
const server = createServer((_req, response) => {
  requestCount++
  response.writeHead(requestCount === 1 ? 503 : 200)
  response.end(requestCount === 1 ? 'retry' : 'ok')
})
let baseUrl = ''

function monitorValues(name: string, overrides: Partial<typeof monitors.$inferInsert> = {}): typeof monitors.$inferInsert {
  const now = Date.now()
  return {
    name,
    type: 'webhook',
    intervalSecs: 60,
    timeoutMs: 1_000,
    retries: 1,
    config: '{}',
    currentStatus: 'pending',
    tags: '[]',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

const poolConfig = (checkConcurrency: number): SchedulerConfig =>
  ({ tickCron: '*/10 * * * * *', resultPurgeCron: '0 2 * * *', resultRetentionDays: 90, checkConcurrency })
const tick = () => new Promise((resolve) => setImmediate(resolve))

before(async () => {
  initTestDb()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

beforeEach(async () => {
  await db.delete(maintenanceWindowMonitors)
  await db.delete(maintenanceWindows)
  await db.delete(monitorDependencies)
  await db.delete(monitorResults)
  await db.delete(monitors)
  requestCount = 0
})

after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  teardownTestDb(testDb)
})

describe('scheduler checks', () => {
  it('retries a failed check, persists recovery, and broadcasts SSE', async () => {
    const [monitor] = await db.insert(monitors).values(monitorValues('Retrying HTTP', {
      type: 'https',
      retries: 2,
      config: JSON.stringify({ url: baseUrl, method: 'GET', expectedStatus: 200 }),
      currentStatus: 'down',
    })).returning()
    const messages: string[] = []
    const client = { raw: { write: (message: string) => messages.push(message) } } as unknown as FastifyReply
    sseService.add(client)

    await runCheck(monitor!)
    sseService.remove(client)

    assert.equal(requestCount, 2)
    const stored = (await db.select().from(monitors).where(eq(monitors.id, monitor!.id)))[0]!
    assert.equal(stored.currentStatus, 'up')
    assert.equal((await db.select().from(monitorResults))[0]!.status, 'up')
    assert.match(messages[0] ?? '', /"status":"up"/)
  })

  it('marks a monitor affected when its dependency is unavailable', async () => {
    requestCount = 1
    const [dependency, dependent] = await db.insert(monitors).values([
      monitorValues('Database', { currentStatus: 'down' }),
      monitorValues('API', {
        type: 'https',
        config: JSON.stringify({ url: baseUrl, method: 'GET', expectedStatus: 200 }),
      }),
    ]).returning()
    await db.insert(monitorDependencies).values({ dependentId: dependent!.id, dependsOnId: dependency!.id })

    await runCheck(dependent!)

    const stored = (await db.select().from(monitors).where(eq(monitors.id, dependent!.id)))[0]!
    assert.equal(stored.currentStatus, 'affected')
    assert.equal((await db.select().from(monitorResults))[0]!.status, 'affected')
  })

  it('keeps failures below the failure threshold out of uptime until the threshold confirms them', async () => {
    const [created] = await db.insert(monitors).values(monitorValues('Flapping', {
      failureThreshold: 3, currentStatus: 'up', alertConfirmedStatus: 'up',
    })).returning()
    const observe = async (status: 'up' | 'down') => {
      const monitor = (await db.select().from(monitors).where(eq(monitors.id, created!.id)))[0]!
      await recordObservation(monitor, { status, responseMs: null, error: status === 'down' ? 'boom' : null })
    }

    await observe('down') // a blip: never confirmed
    await observe('up')
    await observe('down')
    await observe('down')
    const pending = await db.select().from(monitorResults).orderBy(monitorResults.id)
    assert.deepEqual(pending.map((row) => row.unconfirmed), [1, 0, 1, 1])

    await observe('down') // third in a row confirms the outage from its first failure on
    const rows = await db.select().from(monitorResults).orderBy(monitorResults.id)
    assert.deepEqual(rows.map((row) => row.unconfirmed), [1, 0, 0, 0, 0])
    assert.equal((await db.select().from(monitors).where(eq(monitors.id, created!.id)))[0]!.alertConfirmedStatus, 'down')
  })

  it('judges an observation against the current alert state, not the row its check started from', async () => {
    const [created] = await db.insert(monitors).values(monitorValues('Raced', {
      failureThreshold: 2, currentStatus: 'up', alertConfirmedStatus: 'up',
    })).returning()
    const stale = created! // read before another observation (a heartbeat, say) counted a failure
    const down = { status: 'down' as const, responseMs: null, error: 'boom' }

    await recordObservation(stale, down)
    await recordObservation(stale, down) // still holding the old row, yet it is the second failure in a row

    const row = (await db.select().from(monitors).where(eq(monitors.id, created!.id)))[0]!
    assert.equal(row.alertConfirmedStatus, 'down')
    assert.deepEqual((await db.select().from(monitorResults).orderBy(monitorResults.id)).map((r) => r.unconfirmed), [0, 0])
  })

  it('drops the observation of a monitor deleted while its check ran', async () => {
    const [created] = await db.insert(monitors).values(monitorValues('Gone')).returning()
    await db.delete(monitors).where(eq(monitors.id, created!.id))

    await recordObservation(created!, { status: 'up', responseMs: 5, error: null })

    assert.equal((await db.select().from(monitorResults)).length, 0)
  })
})

describe('scheduler orchestration', () => {
  it('selects only due monitors', () => {
    const now = Date.now()
    const base = monitorValues('base', { type: 'https' }) as typeof monitors.$inferSelect
    const due = getDueMonitors([
      { ...base, id: 1, lastCheckedAt: null },
      { ...base, id: 2, lastCheckedAt: now - 61_000 },
      { ...base, id: 3, lastCheckedAt: now - 10_000 },
    ], now)
    assert.deepEqual(due.map((monitor) => monitor.id), [1, 2])
  })

  it('gives a new heartbeat monitor a full interval from creation before it is due', () => {
    const now = Date.now()
    const base = monitorValues('heartbeat', { type: 'webhook' }) as typeof monitors.$inferSelect
    const due = getDueMonitors([
      { ...base, id: 1, lastCheckedAt: null, createdAt: now - 10_000 },
      { ...base, id: 2, lastCheckedAt: null, createdAt: now - 61_000 },
      { ...base, id: 3, lastCheckedAt: now - 61_000, createdAt: now - 10_000 },
    ], now)
    assert.deepEqual(due.map((monitor) => monitor.id), [2, 3])
  })

  it('runs checks through a pool of the configured size', async () => {
    const now = Date.now()
    await db.insert(monitors).values([
      ...Array.from({ length: 25 }, (_, index) => monitorValues(`Due ${index}`, { type: 'https' })),
      monitorValues('Not due', { type: 'https', lastCheckedAt: now }),
    ])
    let active = 0
    let maxActive = 0
    let checked = 0

    await runSchedulerTick(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      checked++
    }, { tickCron: '*/10 * * * * *', resultPurgeCron: '0 2 * * *', resultRetentionDays: 90, checkConcurrency: 7 })

    assert.equal(checked, 25)
    assert.equal(maxActive, 7)
    const health = getSchedulerHealth()
    assert.equal(health.lastDueMonitors, 25)
    assert.equal(health.lastFailedChecks, 0)
    assert.equal(health.lastTickFailed, false)
    assert.ok(health.lastStartedAt)
    assert.ok(health.lastCompletedAt)
    assert.ok(health.lastDurationMs !== null)
  })

  it('records every overdue heartbeat monitor of a tick, though their checks do no I/O', async () => {
    const overdue = Date.now() - 10 * 60_000
    await db.insert(monitors).values(Array.from({ length: 5 }, (_, i) => monitorValues('Heartbeat ' + i, { createdAt: overdue })))

    await runSchedulerTick(undefined, poolConfig(10)) // the real check: a missed heartbeat is down at once

    const results = await db.select().from(monitorResults)
    assert.equal(results.length, 5)
    assert.ok(results.every((row) => row.status === 'down'))
    assert.equal(getSchedulerHealth().lastFailedChecks, 0)
  })

  it('records heartbeats that arrive together, and the tick that follows skips them', async () => {
    const tokens = Array.from({ length: 6 }, (_, i) => String(i + 1).repeat(48).slice(0, 48))
    await db.insert(monitors).values(tokens.map((token, i) => monitorValues('Beat ' + i, {
      webhookToken: token, currentStatus: 'up', alertConfirmedStatus: 'up', createdAt: Date.now() - 10 * 60_000,
    })))
    const app = Fastify()
    await app.register(webhookRoutes, { prefix: '/hook' })
    try {
      const responses = await Promise.all(tokens.map((token) => app.inject({ method: 'GET', url: '/hook/' + token })))
      assert.ok(responses.every((response) => response.statusCode === 200))
      await runSchedulerTick(undefined, poolConfig(10))
    } finally {
      await app.close()
    }
    // One observation per monitor, from its heartbeat: the tick found them observed just now and left them alone.
    const counts = await db.select().from(monitorResults)
    assert.equal(new Set(counts.map((row) => row.monitorId)).size, 6)
    assert.equal(counts.length, 6)
    assert.equal(getSchedulerHealth().lastFailedChecks, 0)
  })

  it('skips a queued monitor that was observed or deleted while it waited', async () => {
    const [first, observed, deleted] = await db.insert(monitors).values([
      monitorValues('First', { type: 'https' }),
      monitorValues('Observed', { type: 'https' }),
      monitorValues('Deleted', { type: 'https' }),
    ]).returning()
    const checked: string[] = []

    // One slot, so the other two wait in the queue while the first runs.
    await runSchedulerTick(async (monitor) => {
      checked.push(monitor.name)
      await db.update(monitors).set({ lastCheckedAt: Date.now() }).where(eq(monitors.id, observed!.id)) // a heartbeat arrives
      await db.delete(monitors).where(eq(monitors.id, deleted!.id))
    }, { tickCron: '*/10 * * * * *', resultPurgeCron: '0 2 * * *', resultRetentionDays: 90, checkConcurrency: 1 })

    assert.deepEqual(checked, [first!.name])
    assert.equal(isCheckInFlight(observed!.id), false)
    assert.equal(isCheckInFlight(deleted!.id), false)
  })

  it('keeps the limit across ticks that overlap', async () => {
    await db.insert(monitors).values(Array.from({ length: 5 }, (_, i) => monitorValues('First ' + i, { type: 'https' })))
    let active = 0
    let maxActive = 0
    let started = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = async () => {
      active++; started++
      maxActive = Math.max(maxActive, active)
      await gate
      active--
    }

    const firstTick = runSchedulerTick(run, poolConfig(3))
    while (started < 3) await tick()
    // The first tick's checks hang; the monitors that become due meanwhile are picked up by the next tick.
    await db.insert(monitors).values(Array.from({ length: 5 }, (_, i) => monitorValues('Second ' + i, { type: 'https' })))
    const secondTick = runSchedulerTick(run, poolConfig(3))
    for (let i = 0; i < 20; i++) await tick()
    assert.equal(started, 3, 'the second tick must wait for a free slot')

    release()
    await Promise.all([firstTick, secondTick])
    assert.equal(started, 10)
    assert.equal(maxActive, 3)
    assert.equal(getSchedulerHealth().lastDueMonitors, 5)
  })

  it('serves queued checks in the order they were queued', async () => {
    const created = await db.insert(monitors).values(Array.from({ length: 6 }, (_, i) => monitorValues('M' + i, { type: 'https' }))).returning()
    const order: number[] = []
    await runSchedulerTick(async (monitor) => {
      order.push(monitor.id)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }, poolConfig(1))
    assert.deepEqual(order, created.map((monitor) => monitor.id))
  })

  it('checks every monitor exactly once and frees its claim, whatever its check does', async () => {
    const created = await db.insert(monitors).values(Array.from({ length: 60 }, (_, i) => monitorValues('S' + i, { type: 'https' }))).returning()
    const runs = new Map<number, number>()
    let active = 0
    let maxActive = 0

    await runSchedulerTick(async (monitor) => {
      runs.set(monitor.id, (runs.get(monitor.id) ?? 0) + 1)
      active++
      maxActive = Math.max(maxActive, active)
      try {
        await new Promise((resolve) => setTimeout(resolve, monitor.id % 7))
        if (monitor.id % 5 === 0) throw new Error('boom')
      } finally {
        active--
      }
    }, poolConfig(8))

    assert.equal(runs.size, 60)
    assert.ok([...runs.values()].every((count) => count === 1))
    assert.ok(maxActive <= 8 && maxActive > 1)
    assert.equal(getSchedulerHealth().lastFailedChecks, 12)
    assert.ok(created.every((monitor) => !isCheckInFlight(monitor.id)))

    // No slot leaked: a following tick with a limit of one still runs everything.
    let again = 0
    await runSchedulerTick(async () => { again++ }, poolConfig(1))
    assert.equal(again, 60)
  })

  it('lets checks waiting from an earlier tick start when a later tick raises the limit', async () => {
    await db.insert(monitors).values(Array.from({ length: 4 }, (_, i) => monitorValues('R' + i, { type: 'https' })))
    let started = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = async () => { started++; await gate }

    const firstTick = runSchedulerTick(run, poolConfig(1))
    while (started < 1) await tick()
    await runSchedulerTick(run, poolConfig(4)) // nothing new is due, but the limit is now four
    while (started < 4) await tick()
    assert.equal(started, 4)

    release()
    await firstTick
  })

  it('never starts a second check for a monitor whose check is still running', async () => {
    const [slow] = await db.insert(monitors).values(monitorValues('Slow', { type: 'https' })).returning()
    const config: SchedulerConfig = { tickCron: '*/10 * * * * *', resultPurgeCron: '0 2 * * *', resultRetentionDays: 90, checkConcurrency: 20 }
    let started = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = async () => { started++; await gate }

    const firstTick = runSchedulerTick(run, config)
    while (started === 0) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(isCheckInFlight(slow!.id), true)

    // The next tick fires while the first check still runs and lastCheckedAt is not written yet.
    await runSchedulerTick(run, config)
    assert.equal(getSchedulerHealth().lastDueMonitors, 0)
    // "Check now" goes through the same guard.
    assert.equal(await runCheck(slow!), false)
    assert.equal(started, 1)
    assert.equal((await db.select().from(monitorResults)).length, 0)

    release()
    await firstTick
    assert.equal(isCheckInFlight(slow!.id), false)
  })

  it('purges results older than 90 days', async () => {
    const [monitor] = await db.insert(monitors).values(monitorValues('Retention')).returning()
    const now = Date.now()
    await db.insert(monitorResults).values([
      { monitorId: monitor!.id, status: 'up', responseMs: 1, checkedAt: now - 91 * 86_400_000, errorMessage: null },
      { monitorId: monitor!.id, status: 'up', responseMs: 1, checkedAt: now - 89 * 86_400_000, errorMessage: null },
    ])

    await purgeOldResults(now, { tickCron: '*/10 * * * * *', resultPurgeCron: '0 2 * * *', resultRetentionDays: 90, checkConcurrency: 20 })
    const remaining = await db.select().from(monitorResults)
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0]!.checkedAt, now - 89 * 86_400_000)
  })
})

describe('maintenance matching', () => {
  it('supports scoped, global, future, and expired windows', async () => {
    const [first, second] = await db.insert(monitors).values([monitorValues('First'), monitorValues('Second')]).returning()
    const now = Date.now()
    const [scoped] = await db.insert(maintenanceWindows).values({
      name: 'Scoped', startsAt: now - 1_000, endsAt: now + 1_000, createdAt: now, updatedAt: now,
    }).returning()
    await db.insert(maintenanceWindowMonitors).values({ windowId: scoped!.id, monitorId: first!.id })

    assert.equal(await isInMaintenance(first!.id, now), true)
    assert.equal(await isInMaintenance(second!.id, now), false)

    await db.insert(maintenanceWindows).values({
      name: 'Global', startsAt: now - 1_000, endsAt: now + 1_000, createdAt: now, updatedAt: now,
    })
    assert.equal(await isInMaintenance(second!.id, now), true)
    assert.equal(await isInMaintenance(second!.id, now + 2_000), false)
  })
})

describe('uptime during maintenance', () => {
  it('leaves failures inside a window out of the uptime counts and keeps recording them', async () => {
    const [monitor] = await db.insert(monitors).values(monitorValues('Nightly')).returning()
    const now = Date.now()
    await recordObservation(monitor!, { status: 'up', responseMs: 5, error: null })
    const [win] = await db.insert(maintenanceWindows).values({
      name: 'Nightly', startsAt: now - 60_000, endsAt: now + 3_600_000, createdAt: now, updatedAt: now,
    }).returning()
    await recordObservation(monitor!, { status: 'down', responseMs: null, error: 'boom' })
    await recordObservation(monitor!, { status: 'down', responseMs: null, error: 'boom' })
    await db.delete(maintenanceWindows).where(eq(maintenanceWindows.id, win!.id))
    await recordObservation(monitor!, { status: 'up', responseMs: 5, error: null })

    assert.equal((await db.select().from(monitorResults).where(eq(monitorResults.monitorId, monitor!.id))).length, 4)
    const stats = await loadMonitorStats(monitor!.id, 1, 90)
    assert.equal(stats.checksTotal, 2)
    assert.equal(stats.checksUp, 2)
    assert.equal(stats.uptimePct, 100)
    assert.equal(stats.recentFailures.length, 2)
    assert.ok(stats.recentFailures.every((failure) => failure.inMaintenance && !failure.unconfirmed))
  })
})

describe('certificate expiry of an HTTPS monitor', () => {
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url))

  it('is read after a check, except for a monitor that ignores TLS errors', async () => {
    const tlsServer = createHttpsServer({ key: fixture('self-signed-key.pem'), cert: fixture('self-signed-cert.pem') }, (_req, res) => { res.writeHead(200).end('ok') })
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve))
    const address = tlsServer.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind')
    const url = `https://127.0.0.1:${address.port}/`
    try {
      const [verifying, ignoring] = await db.insert(monitors).values([
        monitorValues('Verifying', { type: 'https', config: JSON.stringify({ url, method: 'GET', expectedStatus: 200 }) }),
        monitorValues('Ignoring', { type: 'https', config: JSON.stringify({ url, method: 'GET', expectedStatus: 200, ignoreTls: true }) }),
      ]).returning()

      await runCheck(verifying!)
      await runCheck(ignoring!)

      const row = async (id: number) => (await db.select().from(monitors).where(eq(monitors.id, id)))[0]!
      assert.equal((await row(verifying!.id)).currentStatus, 'down', 'the self-signed certificate is rejected')
      assert.equal(typeof (await row(verifying!.id)).certExpiresAt, 'number', 'its expiry is still read')
      assert.equal((await row(ignoring!.id)).currentStatus, 'up')
      assert.equal((await row(ignoring!.id)).certCheckedAt, null)
      assert.equal((await row(ignoring!.id)).certExpiresAt, null)
    } finally {
      tlsServer.closeAllConnections()
      await new Promise<void>((resolve) => tlsServer.close(() => resolve()))
    }
  })
})
