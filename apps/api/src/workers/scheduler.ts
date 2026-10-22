import cron from 'node-cron'
import type { ScheduledTask } from 'node-cron'
import { db, sqlite } from '../db/client.js'
import { deleteEmptyDailyResults } from '../db/dailyResults.js'
import { monitors, monitorResults, maintenanceWindowMonitors, monitorDependencies } from '../db/schema.js'
import { sseService } from '../kit/sse.js'
import { checkHttps } from './https.js'
import { checkPing } from './ping.js'
import { checkDns } from './dns.js'
import { checkSqlServer } from './sqlserver.js'
import { checkPostgres } from './postgres.js'
import { checkMysql } from './mysql.js'
import { checkMongo } from './mongodb.js'
import { checkDocker } from './docker.js'
import { sendNotifications } from './notifier.js'
import { scheduleActionRuns } from './actionRunner.js'
import { checkCertificateExpiry } from './certificate.js'
import { skipsTlsVerification } from './httpAuth.js'
import { RESULT_IN_MAINTENANCE, RESULT_UNCONFIRMED } from '../db/resultMarks.js'
import { activeWindows } from '../services/maintenanceSchedule.js'
import { evaluateAlertTransition, isFailureStatus } from '../services/alertThresholds.js'
import { openIncidentForOutage, resolveIncidentForRecovery } from '../services/autoIncident.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { gt, eq, and, inArray, sql } from 'drizzle-orm'
import type { HttpsConfig, PingConfig, DnsConfig, DatabaseConfig, DockerConfig, MonitorStatus } from '@bsp/shared'
import { getSchedulerConfig, type SchedulerConfig } from '../config/scheduler.js'

export async function isInMaintenance(monitorId: number, now = Date.now()): Promise<boolean> {
  const running = await activeWindows(now)
  if (running.length === 0) return false
  const links = await db.select().from(maintenanceWindowMonitors).where(inArray(maintenanceWindowMonitors.windowId, running.map((win) => win.id)))
  return running.some((win) => {
    const own = links.filter((link) => link.windowId === win.id)
    // Empty link list means all monitors are in maintenance
    return own.length === 0 || own.some((link) => link.monitorId === monitorId)
  })
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
 * Scheduled checks may run at the same time, counted across every tick. Ticks do not wait for each other, so a limit
 * per tick would add up while hanging checks keep earlier ticks alive. Waiting checks are served in the order they
 * were queued. "Check now" is a person waiting for the answer and does not take part.
 */
let slotLimit = 1
let slotsInUse = 0
const slotWaiters: Array<() => void> = []

function handOutSlots(): void {
  while (slotWaiters.length > 0 && slotsInUse < slotLimit) {
    slotsInUse++
    slotWaiters.shift()!()
  }
}

function acquireSlot(): Promise<void> {
  if (slotWaiters.length === 0 && slotsInUse < slotLimit) {
    slotsInUse++
    return Promise.resolve()
  }
  return new Promise((resolve) => slotWaiters.push(resolve))
}

function releaseSlot(): void {
  slotsInUse--
  handOutSlots()
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
  const config = JSON.parse(monitor.config) as HttpsConfig | PingConfig | DnsConfig | DatabaseConfig | DockerConfig
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
        case 'sqlserver': result = await checkSqlServer(config as DatabaseConfig, monitor.timeoutMs); break
        case 'postgresql': result = await checkPostgres(config as DatabaseConfig, monitor.timeoutMs); break
        case 'mysql': result = await checkMysql(config as DatabaseConfig, monitor.timeoutMs); break
        case 'mongodb': result = await checkMongo(config as DatabaseConfig, monitor.timeoutMs); break
        case 'docker': result = await checkDocker(config as DockerConfig, monitor.timeoutMs); break
        case 'webhook': result = { status: 'down', responseMs: null, error: 'No webhook received within interval' }; break
        default: result = { status: 'down', responseMs: null, error: `Unknown type: ${monitor.type}` }
      }
      if (result.status !== 'down' || attempt === maxAttempts) break
    }
  } catch (err) {
    result = { status: 'down', responseMs: null, error: err instanceof Error ? err.message : String(err) }
  }

  await recordObservation(monitor, await applyDependencies(monitor, result))

  if (monitor.type === 'https' && !skipsTlsVerification(config as HttpsConfig)) {
    await checkCertificateExpiry(monitor, config as HttpsConfig).catch((err) =>
      console.error('[certificate] expiry check failed:', err),
    )
  }
}

/**
 * If any declared dependency is down/degraded/affected, marks the monitor as 'affected'
 * regardless of its own result — the root-cause monitor fires the alert.
 */
export async function applyDependencies(monitor: MonitorRow, result: CheckResult): Promise<CheckResult> {
  const deps = await db.select().from(monitorDependencies).where(eq(monitorDependencies.dependentId, monitor.id))
  if (deps.length === 0) return result
  const depIds = deps.map((d) => d.dependsOnId)
  const depMonitors = await db.select().from(monitors).where(inArray(monitors.id, depIds))
  const hasDownDep = depMonitors.some((d) =>
    d.currentStatus === 'down' || d.currentStatus === 'degraded' || d.currentStatus === 'affected',
  )
  return hasDownDep ? { ...result, status: 'affected' } : result
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

  // Read to write in one transaction: the result and the monitor's state move together. Everything inside is
  // database work only (see withImmediateTransaction); notifications and incidents follow after the commit.
  const recorded = await withImmediateTransaction(async () => {
    // `monitor` was read before the check ran and may be stale: a heartbeat or another observation can have moved
    // the alert_* state and the outage clock since, so the transition is judged against the current row.
    const current = (await db.select().from(monitors).where(eq(monitors.id, monitor.id)))[0]
    if (!current) return null // deleted while its check ran

    const inMaintenance = await isInMaintenance(current.id, checkedAt)
    // The public status always reflects the latest observation; only alerting is debounced, via
    // the separate alert_* columns, so a flapping endpoint cannot page anyone every interval.
    const transition = inMaintenance ? null : evaluateAlertTransition(current, result.status)
    // A failure still short of the failure threshold does not count against uptime (yet).
    const unconfirmed = transition !== null && isFailureStatus(result.status) && transition.alertConfirmedStatus !== result.status

    const inserted = (await db.insert(monitorResults).values({
      monitorId: current.id,
      status: result.status,
      responseMs: result.responseMs,
      checkedAt,
      errorMessage: result.error,
      unconfirmed: inMaintenance && result.status !== 'up' ? RESULT_IN_MAINTENANCE : unconfirmed ? RESULT_UNCONFIRMED : 0,
    }).returning({ id: monitorResults.id }))[0]!

    // Once the threshold confirms the failure, the outage started with the first failure of the
    // streak: the observations that were waiting for confirmation now count against uptime too.
    if (transition?.fire && isFailureStatus(transition.fire.status)) {
      await db.update(monitorResults).set({ unconfirmed: 0 }).where(and(
        eq(monitorResults.monitorId, current.id),
        eq(monitorResults.unconfirmed, RESULT_UNCONFIRMED),
        gt(monitorResults.id, sql`(select coalesce(max(id), 0) from monitor_results where monitor_id = ${current.id} and unconfirmed = 0 and id < ${inserted.id})`),
      ))
    }
    // The outage clock starts when a failure is confirmed and stops on a confirmed recovery; a move to 'degraded' keeps it.
    const fireStatus = transition?.fire?.status
    // A monitor already confirmed down before the clock existed (an upgrade) starts it with its next observation.
    const failingSince = fireStatus === 'up' ? null
      : transition?.alertConfirmedStatus === 'down' ? (current.failingSince ?? checkedAt)
        : current.failingSince
    await db.update(monitors).set({
      currentStatus: result.status,
      failingSince,
      lastCheckedAt: checkedAt,
      updatedAt: checkedAt,
      ...(transition ? {
        alertConfirmedStatus: transition.alertConfirmedStatus,
        alertPendingStatus: transition.alertPendingStatus,
        alertPendingCount: transition.alertPendingCount,
      } : {}),
    }).where(eq(monitors.id, current.id))
    return { current, transition, fireStatus, failingSince }
  })
  if (!recorded) return
  const { current, transition, fireStatus, failingSince } = recorded

  // By default always broadcast so the admin UI can update lastCheckedAt and status in real-time.
  if ((options.broadcast ?? 'always') === 'always' || current.currentStatus !== result.status) {
    sseService.broadcast('monitor.status', { monitorId: current.id, status: result.status, responseMs: result.responseMs, checkedAt })
  }

  const fire = transition?.fire
  if (fire) {
    sendNotifications(current, fire.status, fire.previousStatus, result.error).catch((err) =>
      console.error('[notifier] sendNotifications failed:', err),
    )
    scheduleActionRuns(current, fire.status, fire.previousStatus, result.error).catch((err) =>
      console.error('[actions] scheduleActionRuns failed:', err),
    )
  }

  // Checked on every observation, not only on transitions: the incident opens once the outage has lasted long enough.
  try {
    if (fireStatus === 'up') await resolveIncidentForRecovery(current, checkedAt)
    else if (transition?.alertConfirmedStatus === 'down') await openIncidentForOutage({ ...current, failingSince }, result.error, checkedAt)
  } catch (err) {
    console.error('[auto-incident] failed:', err)
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
    // not pick up a monitor that is still waiting for a slot in an earlier one.
    const due = getDueMonitors(allMonitors, startedAt).filter((monitor) => !inFlight.has(monitor.id))
    for (const monitor of due) inFlight.add(monitor.id)
    let failedChecks = 0

    slotLimit = config.checkConcurrency
    handOutSlots() // a raised limit lets waiting checks of earlier ticks start
    await Promise.all(due.map(async (queued) => {
      await acquireSlot()
      try {
        // The row was read when the tick started and may have waited for its slot since. Take the current one, and
        // skip a monitor that was deleted or observed meanwhile (a heartbeat counts as a check).
        const monitor = (await db.select().from(monitors).where(eq(monitors.id, queued.id)))[0]
        if (monitor && getDueMonitors([monitor]).length > 0) await run(monitor)
      } catch {
        failedChecks++
      } finally {
        releaseSlot()
        inFlight.delete(queued.id)
      }
    }))

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

const PURGE_BATCH_ROWS = 5_000

export async function purgeOldResults(now = Date.now(), config: SchedulerConfig = getSchedulerConfig()) {
  const cutoff = now - config.resultRetentionDays * 24 * 60 * 60 * 1000
  // A day of results of many monitors is a long statement, and nothing else in the process runs meanwhile. Deleted in
  // small batches per monitor (an index range each) with the event loop free between them: checks, live updates and
  // requests wait for one batch at most.
  const deleteBatch = sqlite.prepare(
    'DELETE FROM monitor_results WHERE id IN (SELECT id FROM monitor_results WHERE monitor_id = ? AND checked_at < ? LIMIT ?)',
  )
  for (const { id } of await db.select({ id: monitors.id }).from(monitors)) {
    for (;;) {
      const { changes } = deleteBatch.run(id, cutoff, PURGE_BATCH_ROWS)
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (Number(changes) < PURGE_BATCH_ROWS) break
    }
  }
  deleteEmptyDailyResults(sqlite)
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
