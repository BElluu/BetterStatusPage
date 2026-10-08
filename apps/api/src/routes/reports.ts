import type { FastifyInstance, FastifyReply } from 'fastify'
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { incidentMonitors, incidents, monitorResults, monitors } from '../db/schema.js'
import type { UptimeReport, UptimeReportMonitor } from '@bsp/shared'
import { getSchedulerConfig } from '../config/scheduler.js'
import { csvDocument } from '../lib/csv.js'

const DAY_MS = 86_400_000
const MAX_RANGE_DAYS = 366
const DEFAULT_RANGE_DAYS = 30
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

interface Range { from: string; to: string; fromMs: number; toMs: number }
interface DayCounts { checksTotal: number; checksUp: number }
type DailyMonitor = UptimeReportMonitor & { days: Map<string, DayCounts> }

function parseDay(value: string): number | null {
  if (!DATE_PATTERN.test(value)) return null
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value ? null : ms
}

/** UTC calendar days, both ends included; defaults to the last 30 days ending today. */
function parseRange(query: { from?: string; to?: string }): Range | string {
  const todayMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`)
  const toMs = query.to === undefined ? todayMs : parseDay(query.to)
  if (toMs === null) return 'from and to must be dates in the form YYYY-MM-DD'
  const fromMs = query.from === undefined ? toMs - (DEFAULT_RANGE_DAYS - 1) * DAY_MS : parseDay(query.from)
  if (fromMs === null) return 'from and to must be dates in the form YYYY-MM-DD'
  if (fromMs > toMs) return 'from must not be after to'
  if ((toMs - fromMs) / DAY_MS + 1 > MAX_RANGE_DAYS) return `The range must not exceed ${MAX_RANGE_DAYS} days`
  return { from: new Date(fromMs).toISOString().slice(0, 10), to: new Date(toMs).toISOString().slice(0, 10), fromMs, toMs }
}

function percentage(up: number, total: number): number | null {
  return total > 0 ? (up / total) * 100 : null
}

async function loadReport(range: Range, monitorId: number | null): Promise<DailyMonitor[]> {
  const endMs = range.toMs + DAY_MS
  const day = sql<string>`strftime('%Y-%m-%d', ${monitorResults.checkedAt} / 1000, 'unixepoch')`
  const monitorFilter = monitorId === null ? undefined : eq(monitors.id, monitorId)

  const [monitorRows, dayRows, incidentRows] = await Promise.all([
    db.select({ id: monitors.id, name: monitors.name }).from(monitors).where(monitorFilter).orderBy(asc(monitors.name), asc(monitors.id)),
    // Counted per monitor and UTC day in SQL, like the status page bars; unconfirmed failures do not lower uptime.
    db.select({
      monitorId: monitorResults.monitorId,
      date: day,
      checksTotal: sql<number>`count(*)`,
      checksUp: sql<number>`sum(case when ${monitorResults.status} = 'up' or ${monitorResults.unconfirmed} = 1 then 1 else 0 end)`,
      responseSum: sql<number | null>`sum(${monitorResults.responseMs})`,
      responseCount: sql<number>`count(${monitorResults.responseMs})`,
    }).from(monitorResults)
      .where(and(
        gte(monitorResults.checkedAt, range.fromMs),
        lt(monitorResults.checkedAt, endMs),
        monitorId === null ? undefined : eq(monitorResults.monitorId, monitorId),
      ))
      .groupBy(monitorResults.monitorId, day),
    db.select({ monitorId: incidentMonitors.monitorId, incidentId: incidents.id })
      .from(incidentMonitors)
      .innerJoin(incidents, eq(incidents.id, incidentMonitors.incidentId))
      .where(and(
        lt(incidents.startedAt, endMs),
        sql`(${incidents.resolvedAt} is null or ${incidents.resolvedAt} >= ${range.fromMs})`,
        monitorId === null ? undefined : eq(incidentMonitors.monitorId, monitorId),
      )),
  ])

  const byId = new Map<number, DailyMonitor>(monitorRows.map((row) => [row.id, {
    monitorId: row.id, monitorName: row.name, checksTotal: 0, checksUp: 0, uptimePct: null, avgResponseMs: null, incidents: 0,
    days: new Map(),
  }]))
  const responses = new Map<number, { sum: number; count: number }>()
  for (const row of dayRows) {
    const monitor = byId.get(row.monitorId)
    if (!monitor) continue // results of a deleted monitor
    const checksTotal = Number(row.checksTotal)
    const checksUp = Number(row.checksUp)
    monitor.days.set(row.date, { checksTotal, checksUp })
    monitor.checksTotal += checksTotal
    monitor.checksUp += checksUp
    const response = responses.get(row.monitorId) ?? { sum: 0, count: 0 }
    response.sum += Number(row.responseSum ?? 0)
    response.count += Number(row.responseCount)
    responses.set(row.monitorId, response)
  }
  for (const row of incidentRows) {
    const monitor = byId.get(row.monitorId)
    if (monitor) monitor.incidents += 1
  }
  for (const monitor of byId.values()) {
    monitor.uptimePct = percentage(monitor.checksUp, monitor.checksTotal)
    const response = responses.get(monitor.monitorId)
    monitor.avgResponseMs = response && response.count > 0 ? response.sum / response.count : null
  }
  return [...byId.values()]
}

const formatPct = (value: number | null) => value === null ? '' : value.toFixed(3)
const formatMs = (value: number | null) => value === null ? '' : Math.round(value)

function summaryCsv(range: Range, rows: DailyMonitor[]): string {
  return csvDocument(
    ['monitor_id', 'monitor', 'from', 'to', 'checks_total', 'checks_up', 'uptime_pct', 'avg_response_ms', 'incidents'],
    rows.map((m) => [m.monitorId, m.monitorName, range.from, range.to, m.checksTotal, m.checksUp, formatPct(m.uptimePct), formatMs(m.avgResponseMs), m.incidents]),
  )
}

/** One row per monitor and day, days without results included so gaps stay visible. */
function dailyCsv(range: Range, rows: DailyMonitor[]): string {
  const lines: unknown[][] = []
  for (const m of rows) {
    for (let ms = range.fromMs; ms <= range.toMs; ms += DAY_MS) {
      const date = new Date(ms).toISOString().slice(0, 10)
      const counts = m.days.get(date)
      lines.push([m.monitorId, m.monitorName, date, counts?.checksTotal ?? 0, counts?.checksUp ?? 0, formatPct(counts ? percentage(counts.checksUp, counts.checksTotal) : null)])
    }
  }
  return csvDocument(['monitor_id', 'monitor', 'date', 'checks_total', 'checks_up', 'uptime_pct'], lines)
}

export async function reportRoutes(app: FastifyInstance) {
  type Query = { from?: string; to?: string; monitorId?: string }

  function parseQuery(query: Query, reply: FastifyReply): { range: Range; monitorId: number | null } | null {
    const range = parseRange(query)
    const monitorId = query.monitorId === undefined || query.monitorId === '' ? null : Number(query.monitorId)
    if (typeof range === 'string') { void reply.code(400).send({ error: range }); return null }
    if (monitorId !== null && (!Number.isInteger(monitorId) || monitorId < 1)) {
      void reply.code(400).send({ error: 'monitorId must be a positive integer' })
      return null
    }
    return { range, monitorId }
  }

  app.get<{ Querystring: Query }>('/uptime', async (req, reply): Promise<UptimeReport | undefined> => {
    const parsed = parseQuery(req.query, reply)
    if (!parsed) return undefined
    const rows = await loadReport(parsed.range, parsed.monitorId)
    reply.header('Cache-Control', 'no-store')
    return {
      from: parsed.range.from,
      to: parsed.range.to,
      retentionDays: getSchedulerConfig().resultRetentionDays,
      monitors: rows.map(({ days: _days, ...monitor }) => monitor),
    }
  })

  app.get<{ Querystring: Query & { granularity?: string } }>('/uptime/export', async (req, reply) => {
    const parsed = parseQuery(req.query, reply)
    if (!parsed) return reply
    const { granularity } = req.query
    if (granularity !== undefined && granularity !== 'day' && granularity !== 'total') {
      return reply.code(400).send({ error: 'granularity must be day or total' })
    }
    const rows = await loadReport(parsed.range, parsed.monitorId)
    const daily = granularity !== 'total'
    return reply.type('text/csv; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="uptime-${daily ? 'daily' : 'summary'}-${parsed.range.from}-${parsed.range.to}.csv"`)
      .send(daily ? dailyCsv(parsed.range, rows) : summaryCsv(parsed.range, rows))
  })
}
