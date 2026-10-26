import { and, eq, gte, inArray, isNotNull, isNull, lt } from 'drizzle-orm'
import { LATENCY_BASELINE_DAYS } from '@bsp/shared'
import type { LatencyAlertSettings } from '@bsp/shared'
import { db } from '../db/client.js'
import { monitorResults, monitors } from '../db/schema.js'
import { percentileOf } from '../services/monitorStats.js'
import { sendLatencyNotifications } from './notifier.js'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** The baseline is measured again at most this often; a monitor is not re-scanned on every check. */
export const BASELINE_REFRESH_MS = HOUR_MS
/**
 * A window with fewer timed checks says too little to compare: a long interval has two checks in half an hour. At 21 the
 * p95 is the second highest of them, so a single slow check never decides it; at 20 it would be the highest.
 */
export const MIN_WINDOW_SAMPLES = 21
/** A baseline needs a day of history and enough checks, or it describes a moment rather than the usual. */
export const MIN_BASELINE_SAMPLES = 50
export const MIN_BASELINE_SPAN_MS = DAY_MS

type MonitorRow = typeof monitors.$inferSelect

/** A slow check still counts: slowness is what is measured. Failures have no response time worth comparing. */
const TIMED_STATUSES = ['up', 'degraded']

export interface LatencyState {
  /** When the open alert was confirmed; null while there is none. */
  since: number | null
  /** Consecutive checks agreeing on the opposite state: towards an alert, or towards its recovery. */
  count: number
}

export interface LatencyOutcome {
  event: 'alert' | 'recovery' | null
  state: LatencyState
  /** The p95 of the window; null when it held too few checks to judge. */
  p95Ms: number | null
}

/**
 * Judges one window of response times against the baseline. The same hysteresis as the failure thresholds: an alert
 * needs `sustain` consecutive checks above the limit, its recovery `sustain` consecutive checks back below the
 * halfway point between the baseline and the limit, so a p95 hovering at the limit does not flap.
 */
export function evaluateLatency(input: {
  samples: number[]
  baselineMs: number
  settings: LatencyAlertSettings
  state: LatencyState
  now: number
}): LatencyOutcome {
  const { samples, baselineMs, settings, state, now } = input
  if (samples.length < MIN_WINDOW_SAMPLES) return { event: null, state, p95Ms: null }

  const p95Ms = percentileOf([...samples].sort((a, b) => a - b), 0.95)!
  const alerting = state.since !== null
  // Both conditions have to be met to alert, so the limit is the higher of the two. Recovery is judged against the
  // same limit: with a small baseline the minimum rise decides it, and a p95 that never alerts must also end an alert.
  const limitMs = Math.max(baselineMs * settings.factor, baselineMs + settings.minDeltaMs)
  const agrees = alerting ? p95Ms < baselineMs + (limitMs - baselineMs) / 2 : p95Ms >= limitMs
  const count = agrees ? state.count + 1 : 0
  if (count < settings.sustain) return { event: null, state: { since: state.since, count }, p95Ms }
  return alerting
    ? { event: 'recovery', state: { since: null, count: 0 }, p95Ms }
    : { event: 'alert', state: { since: now, count: 0 }, p95Ms }
}

/** Response times of the checks that have one in [from, to), with the time of the first and the last of them. */
async function loadTimedResults(monitorId: number, from: number, to: number): Promise<{ ms: number[]; first: number; last: number }> {
  const rows = await db.select({ ms: monitorResults.responseMs, at: monitorResults.checkedAt }).from(monitorResults).where(and(
    eq(monitorResults.monitorId, monitorId),
    gte(monitorResults.checkedAt, from),
    lt(monitorResults.checkedAt, to),
    inArray(monitorResults.status, TIMED_STATUSES),
    isNotNull(monitorResults.responseMs),
  ))
  let first = Infinity
  let last = -Infinity
  for (const row of rows) {
    if (row.at < first) first = row.at
    if (row.at > last) last = row.at
  }
  return { ms: rows.map((row) => row.ms!), first, last }
}

/**
 * The usual p95 of a monitor: its previous seven days, without the window that is being judged, so a slowdown does
 * not raise its own baseline. Null while the history is too short or too sparse to call anything usual.
 */
export async function measureBaseline(monitorId: number, windowMinutes: number, now = Date.now()): Promise<number | null> {
  const { ms, first, last } = await loadTimedResults(monitorId, now - LATENCY_BASELINE_DAYS * DAY_MS, now - windowMinutes * MINUTE_MS)
  if (ms.length < MIN_BASELINE_SAMPLES || last - first < MIN_BASELINE_SPAN_MS) return null
  return Math.round(percentileOf(ms.sort((a, b) => a - b), 0.95)!)
}

/**
 * The baseline to judge against and to show: the stored one while it is fresh, else measured and stored again, so a
 * monitor is scanned at most once an hour however often its statistics are read. While an alert is open it is the one
 * measured before the alert: measured again it would absorb the slowdown, and a long one would end its own alert.
 */
export async function baselineOf(monitor: MonitorRow, now = Date.now()): Promise<number | null> {
  const frozen = monitor.latencyAlertSince !== null && monitor.latencyBaselineP95 !== null
  // A negative age is a clock that went back: the stored figure is not trusted until the clock catches up.
  const age = monitor.latencyBaselineAt === null ? null : now - monitor.latencyBaselineAt
  if (frozen || (age !== null && age >= 0 && age < BASELINE_REFRESH_MS)) return monitor.latencyBaselineP95
  const measured = await measureBaseline(monitor.id, monitor.latencyAlertWindowMinutes, now)
  // Stored even when null: a monitor with too little history is not scanned again on every check. Only while the
  // window it was measured for is still the monitor's, so a settings change made meanwhile is not overwritten.
  await db.update(monitors).set({ latencyBaselineP95: measured, latencyBaselineAt: now })
    .where(and(eq(monitors.id, monitor.id), eq(monitors.latencyAlertWindowMinutes, monitor.latencyAlertWindowMinutes)))
  return measured
}

/**
 * Judges the latest window of checks of a monitor against its baseline and alerts when it has become slower than
 * usual, or tells that it is back to normal. The monitor's status is left alone: a slow endpoint that still answers
 * is not an outage, and one that stops answering fails the scheduled check, which alerts on its own.
 */
export async function checkLatency(monitorId: number, now = Date.now()): Promise<void> {
  const monitor = (await db.select().from(monitors).where(eq(monitors.id, monitorId)))[0]
  if (!monitor || monitor.latencyAlertFactor === null) return

  const baselineMs = await baselineOf(monitor, now)
  if (baselineMs === null) return

  const settings: LatencyAlertSettings = {
    factor: monitor.latencyAlertFactor,
    windowMinutes: monitor.latencyAlertWindowMinutes,
    minDeltaMs: monitor.latencyAlertMinDeltaMs,
    sustain: monitor.latencyAlertSustain,
  }
  const { ms } = await loadTimedResults(monitor.id, now - settings.windowMinutes * MINUTE_MS, now + 1)
  const outcome = evaluateLatency({
    samples: ms,
    baselineMs,
    settings,
    state: { since: monitor.latencyAlertSince, count: monitor.latencyAlertCount },
    now,
  })

  if (outcome.state.since !== monitor.latencyAlertSince || outcome.state.count !== monitor.latencyAlertCount) {
    // Written only if the monitor is still as it was judged: a settings change that landed while the window was being
    // read has closed the alert or switched it off, and must not be undone by the verdict on the old settings.
    const written = await db.update(monitors).set({
      latencyAlertSince: outcome.state.since,
      latencyAlertCount: outcome.state.count,
      // Once the alert is over the baseline is free to follow the monitor again.
      ...(outcome.event === 'recovery' ? { latencyBaselineAt: null } : {}),
    }).where(and(
      eq(monitors.id, monitor.id),
      eq(monitors.latencyAlertFactor, monitor.latencyAlertFactor),
      eq(monitors.latencyAlertWindowMinutes, monitor.latencyAlertWindowMinutes),
      monitor.latencyAlertSince === null ? isNull(monitors.latencyAlertSince) : eq(monitors.latencyAlertSince, monitor.latencyAlertSince),
      eq(monitors.latencyAlertCount, monitor.latencyAlertCount),
    )).returning({ id: monitors.id })
    if (written.length === 0) return
  }
  if (outcome.event === null || outcome.p95Ms === null) return

  await sendLatencyNotifications(monitor, {
    kind: outcome.event === 'alert' ? 'slow' : 'normal',
    p95Ms: Math.round(outcome.p95Ms),
    baselineMs,
    windowMinutes: settings.windowMinutes,
    since: outcome.event === 'alert' ? now : monitor.latencyAlertSince ?? now,
  })
}
