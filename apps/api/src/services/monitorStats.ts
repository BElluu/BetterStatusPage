import { and, desc, eq, gte, isNotNull, lt, lte, ne, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { RESULT_IN_MAINTENANCE, RESULT_UNCONFIRMED } from '../db/resultMarks.js'
import { countedChecks, countedUp, maintenanceChecks, nonEmptyDay } from './uptimeCounts.js'
import { incidentMonitors, incidents, monitorDailyResults, monitorResults } from '../db/schema.js'
import type { MonitorStats, MonitorStatus } from '@bsp/shared'

const HOUR_MS = 3_600_000
const MAX_BUCKETS = 60
const RECENT_LIMIT = 20
const RECENT_FAILURES_LIMIT = 10

const pct = (up: number, total: number) => (up / total) * 100

/** Value at the given percentile of an ascending list; null when empty. */
export function percentileOf(sorted: number[] | undefined, fraction: number): number | null {
  return sorted && sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]! : null
}

/** What the results alone say; the route adds the baseline, which also depends on the monitor's alert state. */
export async function loadMonitorStats(monitorId: number, hours: number, retentionDays: number): Promise<Omit<MonitorStats, 'baselineP95Ms'>> {
  const to = Date.now()
  const from = to - hours * HOUR_MS
  const bucketMs = Math.ceil(hours / MAX_BUCKETS) * HOUR_MS
  const bucketCount = Math.ceil((to - from) / bucketMs)
  // Uptime bars: hourly up to a day, 6-hourly up to a week, else one per UTC day; aligned to the epoch, so to UTC days.
  const stepHours = hours <= 24 ? 1 : hours <= 168 ? 6 : 24
  const stepMs = stepHours * HOUR_MS
  const barCount = Math.ceil(hours / stepHours)
  const lastBar = Math.floor(to / stepMs)
  const firstBar = lastBar - barCount + 1
  const inWindow = and(eq(monitorResults.monitorId, monitorId), gte(monitorResults.checkedAt, from), lt(monitorResults.checkedAt, to + 1))!
  const up = countedUp
  const bucketIndex = sql<number>`cast((${monitorResults.checkedAt} - ${from}) / ${bucketMs} as integer)`
  const inBarsWindow = and(eq(monitorResults.monitorId, monitorId), gte(monitorResults.checkedAt, firstBar * stepMs), lt(monitorResults.checkedAt, to + 1))!
  const confirmed = (status: 'down' | 'degraded') => sql<number>`sum(case when ${monitorResults.status} = '${sql.raw(status)}' and ${monitorResults.unconfirmed} = 0 then 1 else 0 end)`
  const barIndex = sql<number>`cast(${monitorResults.checkedAt} / ${sql.raw(String(stepMs))} as integer)`

  const [totals, bucketRows, timedRows, barRows, failureRows, incidentRows] = await Promise.all([
    db.select({
      checksTotal: countedChecks,
      checksUp: up,
      timed: sql<number>`count(${monitorResults.responseMs})`,
      avg: sql<number | null>`avg(${monitorResults.responseMs})`,
      min: sql<number | null>`min(${monitorResults.responseMs})`,
      max: sql<number | null>`max(${monitorResults.responseMs})`,
      failures: sql<number>`sum(case when ${monitorResults.status} != 'up' and ${monitorResults.unconfirmed} = 0 then 1 else 0 end)`,
    }).from(monitorResults).where(inWindow),
    db.select({
      index: bucketIndex,
      checksTotal: countedChecks,
      checksUp: up,
      avg: sql<number | null>`avg(${monitorResults.responseMs})`,
      min: sql<number | null>`min(${monitorResults.responseMs})`,
      max: sql<number | null>`max(${monitorResults.responseMs})`,
      down: confirmed('down'),
      degraded: confirmed('degraded'),
    }).from(monitorResults).where(inWindow).groupBy(bucketIndex),
    db.select({ index: bucketIndex, ms: monitorResults.responseMs }).from(monitorResults)
      .where(and(inWindow, isNotNull(monitorResults.responseMs)))
      .orderBy(bucketIndex, monitorResults.responseMs),
    // Daily bars are UTC days, which the database keeps totals for (see db/dailyResults.ts); shorter bars are counted from the results.
    stepHours === 24
      ? db.select({
        index: monitorDailyResults.day, checksTotal: monitorDailyResults.checksTotal, checksUp: monitorDailyResults.checksUp,
        maintenanceChecks: monitorDailyResults.maintenanceChecks,
      }).from(monitorDailyResults).where(and(
        eq(monitorDailyResults.monitorId, monitorId), gte(monitorDailyResults.day, firstBar), lte(monitorDailyResults.day, lastBar), nonEmptyDay,
      ))
      : db.select({ index: barIndex, checksTotal: countedChecks, checksUp: up, maintenanceChecks })
        .from(monitorResults).where(inBarsWindow).groupBy(barIndex),
    db.select({
      checkedAt: monitorResults.checkedAt, status: monitorResults.status, responseMs: monitorResults.responseMs,
      errorMessage: monitorResults.errorMessage, unconfirmed: monitorResults.unconfirmed,
    }).from(monitorResults).where(and(inWindow, ne(monitorResults.status, 'up')))
      .orderBy(desc(monitorResults.checkedAt)).limit(RECENT_FAILURES_LIMIT),
    db.select({
      id: incidents.id, title: incidents.title, status: incidents.status, impact: incidents.impact,
      startedAt: incidents.startedAt, resolvedAt: incidents.resolvedAt,
    }).from(incidentMonitors)
      .innerJoin(incidents, eq(incidents.id, incidentMonitors.incidentId))
      .where(and(
        eq(incidentMonitors.monitorId, monitorId),
        lt(incidents.startedAt, to),
        sql`(${incidents.resolvedAt} is null or ${incidents.resolvedAt} >= ${from})`,
      ))
      .orderBy(desc(incidents.startedAt)),
  ])

  const t = totals[0]!
  const checksTotal = Number(t.checksTotal)
  const checksUp = Number(t.checksUp ?? 0)
  const timed = Number(t.timed)

  const overall = timed > 0 ? timedRows.map((row) => row.ms!).sort((a, b) => a - b) : []
  // The totals and the rows are separate queries: a result written between them is in one and not the other.
  const response = timed > 0 && overall.length > 0
    ? {
        avg: Number(t.avg), min: Number(t.min), max: Number(t.max),
        // From the response times already loaded for the buckets: one sort instead of three more queries over the window.
        p50: percentileOf(overall, 0.5)!,
        p95: percentileOf(overall, 0.95)!,
        p99: percentileOf(overall, 0.99)!,
      }
    : null

  const timedByBucket = new Map<number, number[]>()
  for (const row of timedRows) {
    const index = Number(row.index)
    const list = timedByBucket.get(index)
    if (list) list.push(row.ms!)
    else timedByBucket.set(index, [row.ms!])
  }
  const barByIndex = new Map(barRows.map((row) => [Number(row.index), row]))
  const byIndex = new Map(bucketRows.map((row) => [Number(row.index), row]))
  const buckets = Array.from({ length: bucketCount }, (_, i) => {
    const row = byIndex.get(i)
    return {
      ts: Math.min(from + (i + 1) * bucketMs, to),
      checksTotal: row ? Number(row.checksTotal) : 0,
      checksUp: row ? Number(row.checksUp ?? 0) : 0,
      avgMs: row?.avg == null ? null : Number(row.avg),
      minMs: row?.min == null ? null : Number(row.min),
      maxMs: row?.max == null ? null : Number(row.max),
      p95Ms: percentileOf(timedByBucket.get(i), 0.95),
      down: row ? Number(row.down ?? 0) : 0,
      degraded: row ? Number(row.degraded ?? 0) : 0,
    }
  })

  const resolved = incidentRows.filter((i) => i.resolvedAt !== null)
  return {
    monitorId, hours, from, to, retentionDays,
    checksTotal,
    checksUp,
    uptimePct: checksTotal > 0 ? pct(checksUp, checksTotal) : null,
    failures: Number(t.failures ?? 0),
    response,
    buckets,
    uptime: {
      stepHours,
      bars: Array.from({ length: barCount }, (_, i) => {
        const row = barByIndex.get(firstBar + i)
        return {
          ts: (firstBar + i) * stepMs, checksTotal: row ? Number(row.checksTotal) : 0, checksUp: row ? Number(row.checksUp ?? 0) : 0,
          maintenanceChecks: row ? Number(row.maintenanceChecks ?? 0) : 0,
        }
      }),
    },
    incidents: {
      total: incidentRows.length,
      mttrMs: resolved.length > 0 ? resolved.reduce((sum, i) => sum + (i.resolvedAt! - i.startedAt), 0) / resolved.length : null,
      recent: incidentRows.slice(0, RECENT_LIMIT),
    },
    recentFailures: failureRows.map((row) => ({
      checkedAt: row.checkedAt, status: row.status as MonitorStatus, responseMs: row.responseMs,
      errorMessage: row.errorMessage, unconfirmed: row.unconfirmed === RESULT_UNCONFIRMED, inMaintenance: row.unconfirmed === RESULT_IN_MAINTENANCE,
    })),
  }
}
