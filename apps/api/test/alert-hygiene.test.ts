import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import { db, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { monitorNotificationChannels, monitors, notificationChannels, notificationDeliveries, notificationDeliveryAttempts } from '../src/db/schema.js'
import { isWithinQuietHours, normalizeAlertPolicy, quietHoursEndAt } from '../src/services/alertPolicy.js'
import { evaluateAlertTransition, type AlertThresholdState } from '../src/services/alertThresholds.js'
import { processDueNotificationDeliveries, sendNotifications } from '../src/workers/notifier.js'
import { runCheck } from '../src/workers/scheduler.js'
import type { ChannelAlertPolicy, MonitorStatus, QuietHoursPolicy } from '@bsp/shared'

const dataDir = mkdtempSync(join(tmpdir(), 'bsp-alert-hygiene-test-'))
process.env['DATABASE_PATH'] = join(dataDir, 'test.sqlite')

const requests: Array<{ url: string; body: string }> = []
const server = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    requests.push({ url: request.url ?? '', body: Buffer.concat(chunks).toString() })
    response.writeHead(204).end()
  })
})
let baseUrl = ''

const HOUR_MS = 60 * 60 * 1000

function utcHhMm(at: number): string {
  const date = new Date(at)
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
}

/** A UTC quiet window that is guaranteed to contain `at`, however the suite is scheduled. */
function windowAround(at: number): { start: string; end: string } {
  return { start: utcHhMm(at - HOUR_MS), end: utcHhMm(at + HOUR_MS) }
}

function policy(overrides: Partial<ChannelAlertPolicy> = {}): string {
  return JSON.stringify(normalizeAlertPolicy(overrides))
}

async function insertMonitor(name: string, overrides: Partial<typeof monitors.$inferInsert> = {}) {
  const now = Date.now()
  const [monitor] = await db.insert(monitors).values({
    name, type: 'https', intervalSecs: 60, timeoutMs: 1_000, retries: 1,
    config: '{}', currentStatus: 'up', alertConfirmedStatus: 'up', tags: '[]',
    createdAt: now, updatedAt: now, ...overrides,
  }).returning()
  return monitor!
}

async function insertWebhookChannel(name: string, path: string, alertPolicy: string, notifyOnRecovery = 1) {
  const now = Date.now()
  const [channel] = await db.insert(notificationChannels).values({
    name, type: 'webhook',
    config: JSON.stringify({
      url: `${baseUrl}${path}`, method: 'POST',
      body: '{"monitor":"{{monitor_name}}","list":"{{monitor_list}}","count":"{{affected_count}}"}',
    }),
    enabled: 1, notifyOnRecovery, alertPolicy, createdAt: now, updatedAt: now,
  }).returning()
  return channel!
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error('condition was not met in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

before(async () => {
  initDb()
  runMigrations()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

beforeEach(async () => {
  requests.length = 0
  await db.delete(notificationDeliveryAttempts)
  await db.delete(notificationDeliveries)
  await db.delete(monitorNotificationChannels)
  await db.delete(notificationChannels)
  await db.delete(monitors)
})

after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})

// ── Thresholds ───────────────────────────────────────────────────────────────

describe('alert thresholds', () => {
  const base: AlertThresholdState = {
    alertConfirmedStatus: 'up', alertPendingStatus: null, alertPendingCount: 0,
    failureThreshold: 1, recoveryThreshold: 1,
  }

  /** Replays a sequence of observations and returns the statuses that would have been notified. */
  function replay(state: AlertThresholdState, observations: MonitorStatus[]): string[] {
    const fired: string[] = []
    let current = state
    for (const observed of observations) {
      const next = evaluateAlertTransition(current, observed)
      if (next.fire) fired.push(next.fire.status)
      current = { ...current, ...next }
    }
    return fired
  }

  it('notifies on every status change when both thresholds are 1', () => {
    assert.deepEqual(replay(base, ['down', 'down', 'up', 'down']), ['down', 'up', 'down'])
  })

  it('waits for the configured number of consecutive failures', () => {
    const state = { ...base, failureThreshold: 3 }
    assert.deepEqual(replay(state, ['down', 'down']), [])
    assert.deepEqual(replay(state, ['down', 'down', 'down']), ['down'])
  })

  it('never alerts for an endpoint that flaps below the threshold', () => {
    const state = { ...base, failureThreshold: 3 }
    assert.deepEqual(replay(state, ['down', 'up', 'down', 'up', 'down', 'up', 'down']), [])
  })

  it('debounces recovery separately from failure', () => {
    const state = { ...base, alertConfirmedStatus: 'down', failureThreshold: 1, recoveryThreshold: 2 }
    assert.deepEqual(replay(state, ['up']), [])
    assert.deepEqual(replay(state, ['up', 'up']), ['up'])
  })

  it('keeps severity changes and dependency transitions immediate', () => {
    const state = { ...base, alertConfirmedStatus: 'degraded', failureThreshold: 5, recoveryThreshold: 5 }
    assert.deepEqual(replay(state, ['down']), ['down'])
    assert.deepEqual(replay({ ...base, failureThreshold: 5 }, ['affected']), ['affected'])
  })

  it('resets the streak when the candidate status changes', () => {
    const state = { ...base, failureThreshold: 3 }
    // Two downs, then a degraded, then two more downs: neither candidate ever reaches three.
    assert.deepEqual(replay(state, ['down', 'down', 'degraded', 'down', 'down']), [])
  })
})

// ── Quiet-hours and policy maths ─────────────────────────────────────────────

describe('channel alert policy', () => {
  function quiet(overrides: Partial<QuietHoursPolicy>): QuietHoursPolicy {
    return { enabled: true, start: '22:00', end: '07:00', timezone: 'UTC', mode: 'defer', ...overrides }
  }

  it('recognises a window that wraps past midnight', () => {
    const window = quiet({})
    assert.equal(isWithinQuietHours(window, Date.UTC(2026, 0, 15, 23, 30)), true)
    assert.equal(isWithinQuietHours(window, Date.UTC(2026, 0, 15, 6, 59)), true)
    assert.equal(isWithinQuietHours(window, Date.UTC(2026, 0, 15, 7, 0)), false)
    assert.equal(isWithinQuietHours(window, Date.UTC(2026, 0, 15, 12, 0)), false)
  })

  it('reads the window in the channel timezone, not the server one', () => {
    // 21:30 UTC is 22:30 in Warsaw (UTC+1 in January) — inside the window there, outside in UTC.
    const at = Date.UTC(2026, 0, 15, 21, 30)
    assert.equal(isWithinQuietHours(quiet({ timezone: 'Europe/Warsaw' }), at), true)
    assert.equal(isWithinQuietHours(quiet({ timezone: 'UTC' }), at), false)
  })

  it('treats a same-start-and-end window as never quiet', () => {
    assert.equal(isWithinQuietHours(quiet({ start: '09:00', end: '09:00' }), Date.UTC(2026, 0, 15, 9, 30)), false)
  })

  it('computes when the current window ends', () => {
    assert.equal(quietHoursEndAt(quiet({}), Date.UTC(2026, 0, 15, 23, 30)), Date.UTC(2026, 0, 16, 7, 0))
    assert.equal(quietHoursEndAt(quiet({}), Date.UTC(2026, 0, 15, 6, 0)), Date.UTC(2026, 0, 15, 7, 0))
    assert.equal(
      quietHoursEndAt(quiet({ timezone: 'Europe/Warsaw' }), Date.UTC(2026, 0, 15, 23, 30)),
      Date.UTC(2026, 0, 16, 6, 0),
    )
  })

  it('clamps and repairs untrusted policy input', () => {
    const normalized = normalizeAlertPolicy({
      quietHours: { enabled: 1, start: '25:00', end: '07:00', timezone: 'Mars/Olympus', mode: 'whatever' },
      throttle: { enabled: true, maxAlerts: 0, windowMinutes: 99_999 },
      grouping: { enabled: true, minMonitors: 1, windowSeconds: 2 },
    })
    assert.equal(normalized.quietHours.enabled, true)
    assert.equal(normalized.quietHours.start, '22:00')
    assert.equal(normalized.quietHours.end, '07:00')
    assert.equal(normalized.quietHours.timezone, 'UTC')
    assert.equal(normalized.quietHours.mode, 'defer')
    assert.equal(normalized.throttle.maxAlerts, 1)
    assert.equal(normalized.throttle.windowMinutes, 1_440)
    assert.equal(normalized.grouping.minMonitors, 2)
    assert.equal(normalized.grouping.windowSeconds, 10)
  })

  it('falls back to defaults for missing or broken stored policies', () => {
    const normalized = normalizeAlertPolicy(null)
    assert.equal(normalized.quietHours.enabled, false)
    assert.equal(normalized.throttle.enabled, false)
    assert.equal(normalized.grouping.enabled, false)
  })
})

// ── End-to-end through the notifier ──────────────────────────────────────────

describe('alert hygiene in the notifier', () => {
  it('caps repeat alerts per monitor and never caps recovery', async () => {
    const monitor = await insertMonitor('Checkout API')
    const channel = await insertWebhookChannel('Ops', '/ops', policy({
      throttle: { enabled: true, maxAlerts: 2, windowMinutes: 60 },
    }))
    await db.insert(monitorNotificationChannels).values({ monitorId: monitor.id, channelId: channel.id })

    await sendNotifications(monitor, 'down', 'up', 'timeout')
    await sendNotifications(monitor, 'down', 'up', 'timeout')
    await sendNotifications(monitor, 'down', 'up', 'timeout')
    assert.equal(requests.length, 2)

    await sendNotifications(monitor, 'up', 'down', null)
    assert.equal(requests.length, 3)

    const deliveries = await db.select().from(notificationDeliveries)
    const suppressed = deliveries.filter((delivery) => delivery.status === 'suppressed')
    assert.equal(suppressed.length, 1)
    assert.equal(suppressed[0]!.suppressionReason, 'throttled')
    assert.equal(suppressed[0]!.eventType, 'alert')
  })

  it('counts the cap per monitor, not per channel', async () => {
    const first = await insertMonitor('Checkout API')
    const second = await insertMonitor('Search API')
    const channel = await insertWebhookChannel('Ops', '/ops', policy({
      throttle: { enabled: true, maxAlerts: 1, windowMinutes: 60 },
    }))
    await db.insert(monitorNotificationChannels).values([
      { monitorId: first.id, channelId: channel.id },
      { monitorId: second.id, channelId: channel.id },
    ])

    await sendNotifications(first, 'down', 'up', null)
    await sendNotifications(second, 'down', 'up', null)
    await sendNotifications(first, 'down', 'up', null)

    assert.equal(requests.length, 2)
    const suppressed = (await db.select().from(notificationDeliveries)).filter((d) => d.status === 'suppressed')
    assert.equal(suppressed.length, 1)
    assert.equal(suppressed[0]!.monitorId, first.id)
  })

  it('holds notifications during quiet hours and releases them when the window ends', async () => {
    const now = Date.now()
    const window = windowAround(now)
    const monitor = await insertMonitor('Checkout API')
    const channel = await insertWebhookChannel('Ops', '/ops', policy({
      quietHours: { enabled: true, ...window, timezone: 'UTC', mode: 'defer' },
    }))
    await db.insert(monitorNotificationChannels).values({ monitorId: monitor.id, channelId: channel.id })

    await sendNotifications(monitor, 'down', 'up', 'timeout')
    assert.equal(requests.length, 0)

    const [held] = await db.select().from(notificationDeliveries)
    assert.equal(held!.status, 'pending')
    assert.equal(held!.attemptCount, 0)
    assert.ok(held!.nextAttemptAt !== null && held!.nextAttemptAt > now)

    await processDueNotificationDeliveries(held!.nextAttemptAt!)
    assert.equal(requests.length, 1)
    const [released] = await db.select().from(notificationDeliveries)
    assert.equal(released!.status, 'delivered')
  })

  it('drops notifications when quiet hours are set to suppress', async () => {
    const window = windowAround(Date.now())
    const monitor = await insertMonitor('Checkout API')
    const channel = await insertWebhookChannel('Ops', '/ops', policy({
      quietHours: { enabled: true, ...window, timezone: 'UTC', mode: 'suppress' },
    }))
    await db.insert(monitorNotificationChannels).values({ monitorId: monitor.id, channelId: channel.id })

    await sendNotifications(monitor, 'down', 'up', 'timeout')

    assert.equal(requests.length, 0)
    const [delivery] = await db.select().from(notificationDeliveries)
    assert.equal(delivery!.status, 'suppressed')
    assert.equal(delivery!.suppressionReason, 'quiet-hours')
  })

  it('sends normally outside the quiet window', async () => {
    const now = Date.now()
    const monitor = await insertMonitor('Checkout API')
    const channel = await insertWebhookChannel('Ops', '/ops', policy({
      quietHours: { enabled: true, start: utcHhMm(now + 2 * HOUR_MS), end: utcHhMm(now + 3 * HOUR_MS), timezone: 'UTC', mode: 'suppress' },
    }))
    await db.insert(monitorNotificationChannels).values({ monitorId: monitor.id, channelId: channel.id })

    await sendNotifications(monitor, 'down', 'up', 'timeout')
    assert.equal(requests.length, 1)
  })

  it('collapses a burst of monitors into a single digest', async () => {
    const channel = await insertWebhookChannel('Ops', '/ops', policy({
      grouping: { enabled: true, minMonitors: 3, windowSeconds: 60 },
    }))
    const names = ['Checkout API', 'Search API', 'Billing API']
    for (const name of names) {
      const monitor = await insertMonitor(name)
      await db.insert(monitorNotificationChannels).values({ monitorId: monitor.id, channelId: channel.id })
      await sendNotifications(monitor, 'down', 'up', `${name} timed out`)
    }
    assert.equal(requests.length, 0, 'grouped alerts must not go out before the window closes')

    await processDueNotificationDeliveries(Date.now() + 61_000)

    assert.equal(requests.length, 1)
    const payload = JSON.parse(requests[0]!.body) as { monitor: string; list: string; count: string }
    assert.equal(payload.count, '3')
    assert.equal(payload.monitor, '3 monitors')
    for (const name of names) assert.ok(payload.list.includes(name), `digest should mention ${name}`)

    const deliveries = await db.select().from(notificationDeliveries)
    assert.equal(deliveries.filter((d) => d.status === 'suppressed' && d.suppressionReason === 'grouped').length, 3)
    assert.equal(deliveries.filter((d) => d.status === 'delivered').length, 1)
  })

  it('keeps one digest window when a whole scheduler tick fires at once', async () => {
    const channel = await insertWebhookChannel('Ops', '/ops', policy({
      grouping: { enabled: true, minMonitors: 3, windowSeconds: 60 },
    }))
    const created = []
    for (const name of ['Checkout API', 'Search API', 'Billing API', 'Auth API']) {
      const monitor = await insertMonitor(name)
      await db.insert(monitorNotificationChannels).values({ monitorId: monitor.id, channelId: channel.id })
      created.push(monitor)
    }

    // A scheduler tick checks monitors concurrently, so these interleave.
    await Promise.all(created.map((monitor) => sendNotifications(monitor, 'down', 'up', null)))

    const queued = await db.select().from(notificationDeliveries)
    assert.equal(new Set(queued.map((d) => d.groupKey)).size, 1, 'the burst must share a single window')

    await processDueNotificationDeliveries(Date.now() + 61_000)
    assert.equal(requests.length, 1)
    assert.equal((JSON.parse(requests[0]!.body) as { count: string }).count, '4')
  })

  it('counts the rate cap correctly when alerts arrive concurrently', async () => {
    const monitor = await insertMonitor('Checkout API')
    const channel = await insertWebhookChannel('Ops', '/ops', policy({
      throttle: { enabled: true, maxAlerts: 2, windowMinutes: 60 },
    }))
    await db.insert(monitorNotificationChannels).values({ monitorId: monitor.id, channelId: channel.id })

    await Promise.all([1, 2, 3, 4].map(() => sendNotifications(monitor, 'down', 'up', null)))

    assert.equal(requests.length, 2)
    const suppressed = (await db.select().from(notificationDeliveries)).filter((d) => d.status === 'suppressed')
    assert.equal(suppressed.length, 2)
  })

  it('releases a window individually when it never became a burst', async () => {
    const channel = await insertWebhookChannel('Ops', '/ops', policy({
      grouping: { enabled: true, minMonitors: 3, windowSeconds: 60 },
    }))
    for (const name of ['Checkout API', 'Search API']) {
      const monitor = await insertMonitor(name)
      await db.insert(monitorNotificationChannels).values({ monitorId: monitor.id, channelId: channel.id })
      await sendNotifications(monitor, 'down', 'up', null)
    }
    assert.equal(requests.length, 0)

    await processDueNotificationDeliveries(Date.now() + 61_000)

    assert.equal(requests.length, 2)
    const deliveries = await db.select().from(notificationDeliveries)
    assert.equal(deliveries.filter((d) => d.status === 'delivered').length, 2)
    assert.ok(deliveries.every((d) => d.suppressionReason === null))
  })

  it('digests alerts and recoveries separately', async () => {
    const channel = await insertWebhookChannel('Ops', '/ops', policy({
      grouping: { enabled: true, minMonitors: 2, windowSeconds: 60 },
    }))
    const created = []
    for (const name of ['Checkout API', 'Search API']) {
      const monitor = await insertMonitor(name)
      await db.insert(monitorNotificationChannels).values({ monitorId: monitor.id, channelId: channel.id })
      created.push(monitor)
    }
    for (const monitor of created) await sendNotifications(monitor, 'down', 'up', null)
    for (const monitor of created) await sendNotifications(monitor, 'up', 'down', null)

    await processDueNotificationDeliveries(Date.now() + 61_000)

    assert.equal(requests.length, 2, 'one digest for the outage, one for the recovery')
    const digests = (await db.select().from(notificationDeliveries)).filter((d) => d.monitorId === null)
    assert.deepEqual(digests.map((d) => d.eventType).sort(), ['alert', 'recovery'])
  })

  it('leaves channels without a policy behaving exactly as before', async () => {
    const monitor = await insertMonitor('Checkout API')
    const now = Date.now()
    // Simulates a channel created before the alert_policy column existed.
    const [channel] = await db.insert(notificationChannels).values({
      name: 'Legacy', type: 'webhook',
      config: JSON.stringify({ url: `${baseUrl}/legacy`, method: 'POST', body: '{"monitor":"{{monitor_name}}"}' }),
      enabled: 1, notifyOnRecovery: 1, alertPolicy: '{}', createdAt: now, updatedAt: now,
    }).returning()
    await db.insert(monitorNotificationChannels).values({ monitorId: monitor.id, channelId: channel!.id })

    await sendNotifications(monitor, 'down', 'up', 'timeout')
    await sendNotifications(monitor, 'up', 'down', null)

    assert.equal(requests.length, 2)
    const deliveries = await db.select().from(notificationDeliveries)
    assert.ok(deliveries.every((d) => d.status === 'delivered' && d.groupKey === null))
  })
})

// ── Thresholds through the scheduler ─────────────────────────────────────────

describe('alert thresholds in the scheduler', () => {
  it('only notifies once the failure threshold is reached', async () => {
    const monitor = await insertMonitor('Heartbeat', {
      type: 'webhook', currentStatus: 'up', alertConfirmedStatus: 'up', failureThreshold: 3,
    })
    const channel = await insertWebhookChannel('Ops', '/ops', policy())
    await db.insert(monitorNotificationChannels).values({ monitorId: monitor.id, channelId: channel.id })

    const reload = async () => (await db.select().from(monitors).where(eq(monitors.id, monitor.id)))[0]!

    for (let check = 1; check <= 2; check++) {
      await runCheck(await reload())
      const state = await reload()
      assert.equal(state.currentStatus, 'down', 'the public status must reflect reality immediately')
      assert.equal(state.alertConfirmedStatus, 'up', 'no alert is owed yet')
      assert.equal(state.alertPendingCount, check)
      assert.equal((await db.select().from(notificationDeliveries)).length, 0)
    }

    await runCheck(await reload())
    const state = await reload()
    assert.equal(state.alertConfirmedStatus, 'down')
    assert.equal(state.alertPendingCount, 0)

    await waitFor(async () => (await db.select().from(notificationDeliveries)).length === 1)
    const [delivery] = await db.select().from(notificationDeliveries)
    assert.equal(delivery!.targetStatus, 'down')
    assert.equal(delivery!.previousStatus, 'up')
  })
})
