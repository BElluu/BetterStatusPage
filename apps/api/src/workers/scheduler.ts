import cron from 'node-cron'
import type { ScheduledTask } from 'node-cron'
import { db } from '../db/client.js'
import { monitors, monitorResults, maintenanceWindows, maintenanceWindowMonitors, monitorDependencies } from '../db/schema.js'
import { sseService } from '../services/sse.service.js'
import { checkHttps } from './https.js'
import { checkPing } from './ping.js'
import { checkDns } from './dns.js'
import { checkSqlServer } from './sqlserver.js'
import { sendNotifications } from './notifier.js'
import { checkCertificateExpiry } from './certificate.js'
import { evaluateAlertTransition, isFailureStatus } from '../services/alertThresholds.js'
import { lt, gt, eq, and, lte, gte, inArray, sql } from 'drizzle-orm'
import type { HttpsConfig, PingConfig, DnsConfig, SqlServerConfig, MonitorStatus } from '@bsp/shared'
import { getSchedulerConfig, type SchedulerConfig } from '../config/scheduler.js'

export async function isInMaintenance(monitorId: number, now = Date.now()): Promise<boolean> {
  const activeWindows = await db.select().from(maintenanceWindows).where(
    and(lte(maintenanceWindows.startsAt, now), gte(maintenanceWindows.endsAt, now)),
  )
  if (activeWindows.length === 0) return false
  for (const win of activeWindows) {
    const links = await db.select().from(maintenanceWindowMonitors).where(eq(maintenanceWindowMonitors.windowId, win.id))
    // Empty link list means all monitors are in maintenance
    if (links.length === 0) return true
    if (links.some((l) => l.monitorId === monitorId)) return true
  }
  return false
}

type MonitorRow = typeof monitors.$inferSelect
type CheckResult = { status: MonitorStatus; responseMs: number | null; error: string | null }

export function getDueMonitors(allMonitors: MonitorRow[], now = Date.now()): MonitorRow[] {
  return allMonitors.filter((monitor) => {
    // A heartbeat monitor that never received one gets a full interval from creation before it is
    // declared down; every other type is checked right away.
    const since = monitor.lastCheckedAt ?? (monitor.type === 'webhook' ? monitor.createdAt : null)
    return !since || since + monitor.intervalSecs * 1000 <= now
  })
}

/**
 * Monitors whose check is queued or running. lastCheckedAt is only written once a check finishes,
 * so without this a check slower than the tick interval would be started again by the next tick
 * (or by "check now") and could fire the same alert twice.
 */
const inFlight = new Set<number>()

export function isCheckInFlight(monitorId: number): boolean {
  return inFlight.has(monitorId)
}

/**
 * Runs one check unless a check for the same monitor is already queued or running.
 * Resolves to false when it was skipped for that reason.
 */
export async function runCheck(monitor: MonitorRow): Promise<boolean> {
  if (inFlight.has(monitor.id)) return false
  inFlight.add(monitor.id)
  try {
    await performCheck(monitor)
    return true
  } finally {
    inFlight.delete(monitor.id)
  }
}

async function performCheck(monitor: MonitorRow): Promise<void> {
  const config = JSON.parse(monitor.config) as HttpsConfig | PingConfig | DnsConfig | SqlServerConfig
  let result: CheckResult = {
    status: 'down',
    responseMs: null,
    error: 'Monitor check did not run',
  }

  const maxAttempts = (monitor.retries ?? 1)
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      switch (monitor.type) {
        case 'https': result = await checkHttps(config as HttpsConfig, monitor.timeoutMs); break
        case 'ping': result = await checkPing(config as PingConfig, monitor.timeoutMs); break
        case 'dns': result = await checkDns(config as DnsConfig, monitor.timeoutMs); break
        case 'sqlserver': result = await checkSqlServer(config as SqlServerConfig, monitor.timeoutMs); break
        case 'webhook': result = { status: 'down', responseMs: null, error: 'No webhook received within interval' }; break
        default: result = { status: 'down', responseMs: null, error: `Unknown type: ${monitor.type}` }
      }
      if (result.status !== 'down' || attempt === maxAttempts) break
    }
  } catch (err) {
    result = { status: 'down', responseMs: null, error: err instanceof Error ? err.message : String(err) }
  }

  // If any declared dependency is down/degraded/affected, mark this monitor as 'affected'
  // regardless of its own check result — the root-cause monitor fires the alert.
  const deps = await db.select().from(monitorDependencies).where(eq(monitorDependencies.dependentId, monitor.id))
  if (deps.length > 0) {
    const depIds = deps.map((d) => d.dependsOnId)
    const depMonitors = await db.select().from(monitors).where(inArray(monitors.id, depIds))
    const hasDownDep = depMonitors.some((d) =>
      d.currentStatus === 'down' || d.currentStatus === 'degraded' || d.currentStatus === 'affected',
    )
    if (hasDownDep) result = { ...result, status: 'affected' }
  }

  await recordObservation(monitor, result)

  if (monitor.type === 'https') {
    await checkCertificateExpiry(monitor, config as HttpsConfig).catch((err) =>
      console.error('[certificate] expiry check failed:', err),
    )
  }
}

/**
 * Stores one observation of a monitor — a scheduled check or a received heartbeat — and notifies
 * when it confirms an alert-worthy transition.
 *
 * During maintenance the public status still follows reality, but the alert_* state is left
 * untouched: the first observation after the window is then judged against the status that was
 * confirmed before it, so an outage that started inside the window alerts once the window ends.
 */
export async function recordObservation(
  monitor: MonitorRow,
  result: CheckResult,
  options: { broadcast?: 'always' | 'on-change' } = {},
): Promise<void> {
  const checkedAt = Date.now()

  const inMaintenance = await isInMaintenance(monitor.id, checkedAt)
  // The public status always reflects the latest observation; only alerting is debounced, via
  // the separate alert_* columns, so a flapping endpoint cannot page anyone every interval.
  const transition = inMaintenance ? null : evaluateAlertTransition(monitor, result.status)
  // A failure still short of the failure threshold does not count against uptime (yet).
  const unconfirmed = transition !== null && isFailureStatus(result.status) && transition.alertConfirmedStatus !== result.status

  const inserted = (await db.insert(monitorResults).values({
    monitorId: monitor.id,
    status: result.status,
    responseMs: result.responseMs,
    checkedAt,
    errorMessage: result.error,
    unconfirmed: unconfirmed ? 1 : 0,
  }).returning({ id: monitorResults.id }))[0]!

  // Once the threshold confirms the failure, the outage started with the first failure of the
  // streak: the observations that were waiting for confirmation now count against uptime too.
  if (transition?.fire && isFailureStatus(transition.fire.status)) {
    await db.update(monitorResults).set({ unconfirmed: 0 }).where(and(
      eq(monitorResults.monitorId, monitor.id),
      eq(monitorResults.unconfirmed, 1),
      gt(monitorResults.id, sql`(select coalesce(max(id), 0) from monitor_results where monitor_id = ${monitor.id} and unconfirmed = 0 and id < ${inserted.id})`),
    ))
  }
  await db.update(monitors).set({
    currentStatus: result.status,
    lastCheckedAt: checkedAt,
    updatedAt: checkedAt,
    ...(transition ? {
      alertConfirmedStatus: transition.alertConfirmedStatus,
      alertPendingStatus: transition.alertPendingStatus,
      alertPendingCount: transition.alertPendingCount,
    } : {}),
  }).where(eq(monitors.id, monitor.id))

  // By default always broadcast so the admin UI can update lastCheckedAt and status in real-time.
  if ((options.broadcast ?? 'always') === 'always' || monitor.currentStatus !== result.status) {
    sseService.broadcast('monitor.status', { monitorId: monitor.id, status: result.status, responseMs: result.responseMs, checkedAt })
  }

  const fire = transition?.fire
  if (fire) {
    sendNotifications(monitor, fire.status, fire.previousStatus, result.error).catch((err) =>
      console.error('[notifier] sendNotifications failed:', err),
    )
  }
}

export async function runSchedulerTick(
  run: (monitor: MonitorRow) => Promise<unknown> = performCheck,
  config: SchedulerConfig = getSchedulerConfig(),
) {
  const startedAt = Date.now()
  schedulerHealth.lastStartedAt = startedAt
  try {
    const allMonitors = await db.select().from(monitors)
    // Claim every due monitor up front: ticks do not wait for each other, and a later tick must
    // not pick up a monitor that is still waiting for its chunk in an earlier one.
    const due = getDueMonitors(allMonitors, startedAt).filter((monitor) => !inFlight.has(monitor.id))
    for (const monitor of due) inFlight.add(monitor.id)
    let failedChecks = 0

    try {
      for (let i = 0; i < due.length; i += config.checkConcurrency) {
        const chunk = due.slice(i, i + config.checkConcurrency)
        const results = await Promise.allSettled(chunk.map(async (monitor) => {
          try {
            return await run(monitor)
          } finally {
            inFlight.delete(monitor.id)
          }
        }))
        failedChecks += results.filter((result) => result.status === 'rejected').length
      }
    } finally {
      for (const monitor of due) inFlight.delete(monitor.id)
    }

    schedulerHealth.lastCompletedAt = Date.now()
    schedulerHealth.lastDurationMs = schedulerHealth.lastCompletedAt - startedAt
    schedulerHealth.lastDueMonitors = due.length
    schedulerHealth.lastFailedChecks = failedChecks
    schedulerHealth.lastTickFailed = false
  } catch (error) {
    schedulerHealth.lastCompletedAt = Date.now()
    schedulerHealth.lastDurationMs = schedulerHealth.lastCompletedAt - startedAt
    schedulerHealth.lastTickFailed = true
    throw error
  }
}

export async function purgeOldResults(now = Date.now(), config: SchedulerConfig = getSchedulerConfig()) {
  const cutoff = now - config.resultRetentionDays * 24 * 60 * 60 * 1000
  await db.delete(monitorResults).where(lt(monitorResults.checkedAt, cutoff))
  console.log('[scheduler] Purged old monitor results')
}

const tasks: ScheduledTask[] = []

export interface SchedulerHealth {
  running: boolean
  lastStartedAt: number | null
  lastCompletedAt: number | null
  lastDurationMs: number | null
  lastDueMonitors: number
  lastFailedChecks: number
  lastTickFailed: boolean
}

const schedulerHealth: SchedulerHealth = {
  running: false,
  lastStartedAt: null,
  lastCompletedAt: null,
  lastDurationMs: null,
  lastDueMonitors: 0,
  lastFailedChecks: 0,
  lastTickFailed: false,
}

export function getSchedulerHealth(): SchedulerHealth {
  return { ...schedulerHealth }
}

export function startScheduler(config: SchedulerConfig = getSchedulerConfig()): void {
  if (tasks.length > 0) return
  tasks.push(cron.schedule(config.tickCron, () => {
    runSchedulerTick(undefined, config).catch((err) => console.error('[scheduler] tick error:', err))
  }))
  tasks.push(cron.schedule(config.resultPurgeCron, () => {
    purgeOldResults(undefined, config).catch(console.error)
  }))
  schedulerHealth.running = true
  console.log('[scheduler] Started')
}

export function stopScheduler(): void {
  for (const task of tasks.splice(0)) task.destroy()
  schedulerHealth.running = false
}
