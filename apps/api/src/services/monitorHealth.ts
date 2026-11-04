import { and, desc, eq, gt, gte, inArray, lt, min, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { monitorResults } from '../db/schema.js'
import { countedChecks, countedUp } from './uptimeCounts.js'
import { currentLatencyRatio } from '../workers/latencyAnomaly.js'
import type { MonitorHealth } from '@bsp/shared'

const HOUR_MS = 3_600_000
const HOURS = 24

const EMPTY: MonitorHealth = { uptime24h: null, avgResponseMs: null, responseTrend: Array.from({ length: HOURS }, () => null), failureRunSince: null, latencyRatio: null }

interface Total { total: number; up: number; timed: number; sum: number; hourTimed: number[]; hourSum: number[] }

/**
 * How monitors did over the last 24 hours, read in one pass over their results: uptime by the same rule as the
 * statistics (see uptimeCounts.ts), the average response time, and an hourly average for a small trend line.
 * For a monitor that is down or degraded it also finds when its run of failed checks began, and for one with an open
 * slower-than-usual alert, how many times slower than usual it is.
 *
 * The first query names the monitors, so it walks the (monitor_id, checked_at) index instead of the whole table.
 */
export async function loadMonitorHealth(
  monitors: ReadonlyArray<{ id: number; currentStatus: string; latencyAlertSince: number | null; latencyBaselineP95: number | null; latencyAlertWindowMinutes: number }>,
  now = Date.now(),
): Promise<(monitorId: number) => MonitorHealth> {
  if (monitors.length === 0) return () => EMPTY
  const from = now - HOURS * HOUR_MS
  const hour = sql<number>`cast((${monitorResults.checkedAt} - ${from}) / ${HOUR_MS} as integer)`
  const rows = await db.select({
    monitorId: monitorResults.monitorId,
    hour,
    total: countedChecks,
    up: countedUp,
    timed: sql<number>`count(${monitorResults.responseMs})`,
    responseSum: sql<number | null>`sum(${monitorResults.responseMs})`,
  }).from(monitorResults)
    .where(and(
      inArray(monitorResults.monitorId, monitors.map((monitor) => monitor.id)),
      gte(monitorResults.checkedAt, from),
      lt(monitorResults.checkedAt, now + 1),
    ))
    .groupBy(monitorResults.monitorId, hour)

  const totals = new Map<number, Total>()
  for (const row of rows) {
    const entry = totals.get(row.monitorId) ?? { total: 0, up: 0, timed: 0, sum: 0, hourTimed: Array<number>(HOURS).fill(0), hourSum: Array<number>(HOURS).fill(0) }
    entry.total += row.total
    entry.up += row.up
    entry.timed += row.timed
    entry.sum += row.responseSum ?? 0
    // A check at exactly `now` falls in the hour after the last one; it belongs to the last hour.
    const slot = Math.min(HOURS - 1, row.hour)
    entry.hourTimed[slot] = entry.hourTimed[slot]! + row.timed
    entry.hourSum[slot] = entry.hourSum[slot]! + (row.responseSum ?? 0)
    totals.set(row.monitorId, entry)
  }

  // The run of failures starts with the first check after the last one that passed, even if the failure was only
  // confirmed later. The last passing check is found by walking the index backwards, which stops at the first one.
  const failureRunSince = new Map<number, number>()
  for (const monitor of monitors) {
    if (monitor.currentStatus !== 'down' && monitor.currentStatus !== 'degraded') continue
    const [lastPass] = await db.select({ at: monitorResults.checkedAt }).from(monitorResults)
      .where(and(eq(monitorResults.monitorId, monitor.id), eq(monitorResults.status, 'up')))
      .orderBy(desc(monitorResults.checkedAt)).limit(1)
    const [first] = await db.select({ at: min(monitorResults.checkedAt) }).from(monitorResults)
      .where(and(eq(monitorResults.monitorId, monitor.id), gt(monitorResults.checkedAt, lastPass?.at ?? -1)))
    if (first?.at != null) failureRunSince.set(monitor.id, first.at)
  }

  const latencyRatio = new Map<number, number>()
  for (const monitor of monitors) {
    const ratio = await currentLatencyRatio(monitor, now)
    if (ratio !== null) latencyRatio.set(monitor.id, ratio)
  }

  return (monitorId) => {
    const entry = totals.get(monitorId)
    return {
      uptime24h: entry && entry.total > 0 ? (entry.up / entry.total) * 100 : null,
      avgResponseMs: entry && entry.timed > 0 ? entry.sum / entry.timed : null,
      responseTrend: entry ? entry.hourTimed.map((count, i) => (count > 0 ? entry.hourSum[i]! / count : null)) : EMPTY.responseTrend,
      failureRunSince: failureRunSince.get(monitorId) ?? null,
      latencyRatio: latencyRatio.get(monitorId) ?? null,
    }
  }
}
