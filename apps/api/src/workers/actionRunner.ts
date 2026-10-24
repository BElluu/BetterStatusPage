import { and, eq, gt, inArray, lt, lte, ne, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { actionRuns, actions, monitorActions, monitors } from '../db/schema.js'
import { MAX_DELIVERY_ATTEMPTS, RETRY_DELAYS_MS, sendActionFailureNotifications, sendActionSuccessNotifications } from './notifier.js'
import { executeAction, type ActionHttpResult } from './actionHttp.js'
import { isInMaintenance } from './scheduler.js'
import type { ActionHttpConfig } from '@bsp/shared'

const MINUTE_MS = 60_000
/** How long a run is held by the attempt that claimed it; a crash mid-send makes it due again after this. */
const CLAIM_LEASE_MS = 30_000
const activeRuns = new Set<number>()

/** A monitor that was in one of these before it came back up had an outage the 'up' actions are meant to undo. */
const OUTAGE_STATUSES = ['down', 'degraded', 'affected']

type MonitorRow = typeof monitors.$inferSelect

async function cancelPendingRuns(where: SQL, reason: string): Promise<void> {
  const now = Date.now()
  await db.update(actionRuns)
    .set({ status: 'cancelled', nextAttemptAt: null, completedAt: now, lastError: reason, updatedAt: now })
    .where(and(eq(actionRuns.status, 'pending'), where))
}

/** A monitor or action that is deleted takes its waiting runs with it; the history rows stay. */
export function cancelRunsOfMonitor(monitorId: number): Promise<void> {
  return cancelPendingRuns(eq(actionRuns.monitorId, monitorId), 'Monitor was deleted')
}

export function cancelRunsOfAction(actionId: number): Promise<void> {
  return cancelPendingRuns(eq(actionRuns.actionId, actionId), 'Action was deleted')
}

/** Queued runs of a monitor whose action link was removed no longer have a reason to run. */
export async function cancelUnlinkedRuns(monitorId: number, links: { actionId: number; onStatus: string }[]): Promise<void> {
  const pending = await db.select({ id: actionRuns.id, actionId: actionRuns.actionId, onStatus: actionRuns.onStatus })
    .from(actionRuns).where(and(eq(actionRuns.monitorId, monitorId), eq(actionRuns.status, 'pending')))
  const stale = pending.filter((run) => !links.some((l) => l.actionId === run.actionId && l.onStatus === run.onStatus))
  if (stale.length === 0) return
  await cancelPendingRuns(inArray(actionRuns.id, stale.map((run) => run.id)), 'Action was unlinked from the monitor')
}

/**
 * Called when a monitor's alert state changes. Runs still waiting for the old status are cancelled, then every
 * action linked to the new status is queued for `delayMinutes` from now. Resolves to the runs to start at once (an
 * action without a delay); starting them is left to the caller so the queueing can share the transaction that
 * confirmed the change. A queued run that was never started is picked up by `processDueActionRuns`.
 */
export async function planActionRuns(
  monitor: MonitorRow,
  status: string,
  previousStatus: string,
  errorMessage: string | null,
): Promise<number[]> {
  const now = Date.now()
  await db.update(actionRuns)
    .set({ status: 'cancelled', nextAttemptAt: null, completedAt: now, lastError: `Monitor changed to ${status}`, updatedAt: now })
    .where(and(eq(actionRuns.monitorId, monitor.id), eq(actionRuns.status, 'pending'), ne(actionRuns.onStatus, status)))

  if (status !== 'down' && !(status === 'up' && OUTAGE_STATUSES.includes(previousStatus))) return []

  // Two queries, not a join: both tables have an id column, which the driver would map by position.
  const links = await db.select().from(monitorActions)
    .where(and(eq(monitorActions.monitorId, monitor.id), eq(monitorActions.onStatus, status)))
  if (links.length === 0) return []
  const actionRows = await db.select().from(actions).where(inArray(actions.id, links.map((link) => link.actionId)))
  const actionById = new Map(actionRows.map((action) => [action.id, action]))

  const variables = JSON.stringify({
    monitor_name: monitor.name,
    monitor_type: monitor.type,
    status,
    previous_status: previousStatus,
    error_message: errorMessage ?? '',
    checked_at: new Date(now).toISOString(),
    event_type: status === 'down' ? 'alert' : 'recovery',
  })

  const startNow: number[] = []
  for (const link of links) {
    const action = actionById.get(link.actionId)
    if (!action || action.enabled !== 1) continue
    if (link.cooldownMinutes > 0) {
      const recent = await db.select({ id: actionRuns.id }).from(actionRuns).where(and(
        eq(actionRuns.monitorId, monitor.id),
        eq(actionRuns.actionId, action.id),
        eq(actionRuns.onStatus, status),
        ne(actionRuns.status, 'cancelled'),
        gt(actionRuns.createdAt, now - link.cooldownMinutes * MINUTE_MS),
      )).limit(1)
      if (recent.length > 0) continue
    }
    const [run] = await db.insert(actionRuns).values({
      actionId: action.id,
      actionName: action.name,
      monitorId: monitor.id,
      monitorName: monitor.name,
      onStatus: status,
      variables,
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
      nextAttemptAt: now + link.delayMinutes * MINUTE_MS,
      createdAt: now,
      updatedAt: now,
    }).returning({ id: actionRuns.id })
    if (link.delayMinutes === 0) startNow.push(run!.id)
  }
  return startNow
}

/** Queues the runs of a status change and starts those without a delay. */
export async function scheduleActionRuns(
  monitor: MonitorRow,
  status: string,
  previousStatus: string,
  errorMessage: string | null,
): Promise<void> {
  for (const runId of await planActionRuns(monitor, status, previousStatus, errorMessage)) {
    attemptActionRun(runId).catch((err) => console.error('[actions] Run failed:', err))
  }
}

/**
 * Runs one queued action. Before sending, the run is checked against the monitor's confirmed state: a run that
 * waited for 'down' is dropped when the monitor recovered in the meantime, and the same holds on every retry.
 */
export async function attemptActionRun(runId: number, now = Date.now()): Promise<void> {
  if (activeRuns.has(runId)) return
  activeRuns.add(runId)
  try {
    // The claim is atomic, so two workers (or a worker and an immediate attempt) never send the same run.
    const claimed = await db.update(actionRuns)
      .set({ nextAttemptAt: now + CLAIM_LEASE_MS })
      .where(and(eq(actionRuns.id, runId), eq(actionRuns.status, 'pending'), lte(actionRuns.nextAttemptAt, now)))
      .returning()
    const run = claimed[0]
    if (!run) return

    const cancel = async (reason: string) => {
      const completedAt = Date.now()
      await db.update(actionRuns)
        .set({ status: 'cancelled', nextAttemptAt: null, completedAt, lastError: reason, updatedAt: completedAt })
        .where(and(eq(actionRuns.id, runId), eq(actionRuns.status, 'pending')))
    }
    const action = (await db.select().from(actions).where(eq(actions.id, run.actionId)))[0]
    if (!action) return cancel('Action no longer exists')
    if (action.enabled !== 1) return cancel('Action is disabled')
    const monitor = run.monitorId === null ? undefined
      : (await db.select({ alertConfirmedStatus: monitors.alertConfirmedStatus }).from(monitors).where(eq(monitors.id, run.monitorId)))[0]
    if (!monitor) return cancel('Monitor no longer exists')
    if (monitor.alertConfirmedStatus !== run.onStatus) return cancel(`Monitor is no longer ${run.onStatus}`)
    // While a maintenance window is open the confirmed status stays frozen, so the window has to be checked here.
    if (await isInMaintenance(run.monitorId!, now)) return cancel('Monitor is in a maintenance window')
    const link = await db.select({ id: monitorActions.id }).from(monitorActions).where(and(
      eq(monitorActions.monitorId, run.monitorId!), eq(monitorActions.actionId, run.actionId), eq(monitorActions.onStatus, run.onStatus),
    )).limit(1)
    if (link.length === 0) return cancel('Action is no longer linked to the monitor')

    const attemptNumber = run.attemptCount + 1
    try {
      const result = await executeAction(JSON.parse(action.config) as ActionHttpConfig, JSON.parse(run.variables) as Record<string, string>)
      if (!result.ok) throw new Error(result.error)
      const completedAt = Date.now()
      const updated = await db.update(actionRuns).set({
        status: 'succeeded', attemptCount: attemptNumber, nextAttemptAt: null,
        lastAttemptAt: completedAt, completedAt, lastError: null, updatedAt: completedAt,
      }).where(and(eq(actionRuns.id, runId), eq(actionRuns.status, 'pending'))).returning({ id: actionRuns.id })
      // A run that was cancelled while it was sending is not a success to report. Of the rest, only the channels set to
      // hear about successes are told; the notifier decides which.
      if (updated.length > 0) {
        sendActionSuccessNotifications({ ...run, actionName: action.name, attemptCount: attemptNumber }).catch((err) =>
          console.error('[actions] Success notification failed:', err instanceof Error ? err.message : err))
      }
    } catch (error) {
      const completedAt = Date.now()
      const message = error instanceof Error ? error.message : String(error)
      const exhausted = attemptNumber >= run.maxAttempts
      const delay = RETRY_DELAYS_MS[Math.min(attemptNumber - 1, RETRY_DELAYS_MS.length - 1)]!
      const updated = await db.update(actionRuns).set({
        status: exhausted ? 'failed' : 'pending', attemptCount: attemptNumber,
        nextAttemptAt: exhausted ? null : now + delay, lastAttemptAt: completedAt,
        completedAt: exhausted ? completedAt : null, lastError: message, updatedAt: completedAt,
      }).where(and(eq(actionRuns.id, runId), eq(actionRuns.status, 'pending'))).returning({ id: actionRuns.id })
      // Only a run that really ended as failed (it was not cancelled while sending) is worth a notification.
      if (exhausted && updated.length > 0) {
        sendActionFailureNotifications({ ...run, actionName: action.name, attemptCount: attemptNumber }, message).catch((err) =>
          console.error('[actions] Failure notification failed:', err instanceof Error ? err.message : err))
      }
      console.error(`[actions] Run ${runId}, attempt ${attemptNumber} failed: ${message}`)
    }
  } finally { activeRuns.delete(runId) }
}

/**
 * Queues a failed run for another round of attempts, as many as a new run gets. The guards of a normal attempt still
 * apply, so a run that no longer qualifies (the monitor recovered, the link is gone) is cancelled with the reason.
 * Returns false when the run is not a failed one, which also makes a double click harmless.
 */
export async function retryActionRun(runId: number): Promise<boolean> {
  const now = Date.now()
  const updated = await db.update(actionRuns)
    .set({
      status: 'pending',
      maxAttempts: sql`${actionRuns.attemptCount} + ${MAX_DELIVERY_ATTEMPTS}`,
      nextAttemptAt: now, completedAt: null, lastError: null, updatedAt: now,
    })
    .where(and(eq(actionRuns.id, runId), eq(actionRuns.status, 'failed')))
    .returning({ id: actionRuns.id })
  if (updated.length === 0) return false
  await attemptActionRun(runId, now)
  return true
}

export async function processDueActionRuns(now = Date.now()): Promise<number> {
  const due = await db.select({ id: actionRuns.id }).from(actionRuns)
    .where(and(eq(actionRuns.status, 'pending'), lte(actionRuns.nextAttemptAt, now)))
  await Promise.allSettled(due.map((run) => attemptActionRun(run.id, now)))
  return due.length
}

export async function purgeOldActionRuns(now = Date.now()): Promise<void> {
  const cutoff = now - 180 * 24 * 60 * MINUTE_MS
  await db.delete(actionRuns).where(and(lt(actionRuns.createdAt, cutoff), ne(actionRuns.status, 'pending')))
}

/** Sends the action once with sample values, whatever any monitor is doing. This is the real request. */
export async function testAction(actionId: number): Promise<ActionHttpResult> {
  const action = (await db.select().from(actions).where(eq(actions.id, actionId)))[0]
  if (!action) return { ok: false, snippet: '', error: 'Action not found' }
  return executeAction(JSON.parse(action.config) as ActionHttpConfig, {
    monitor_name: 'Test monitor',
    monitor_type: 'https',
    status: 'down',
    previous_status: 'up',
    error_message: 'Test run from BetterStatusPage',
    checked_at: new Date().toISOString(),
    event_type: 'test',
  })
}
