import { db } from '../db/client.js'
import {
  monitors, incidents, incidentMonitors, monitorResults, layout, branding, locales,
  maintenanceWindowMonitors, monitorDependencies,
} from '../db/schema.js'
import { eq, desc, gte, ne, inArray, and, sql } from 'drizzle-orm'
import { countedChecks, countedUp, maintenanceChecks } from './uptimeCounts.js'
import { activeWindows } from './maintenanceSchedule.js'
import { getPublishedMonitorIds } from './publishedMonitors.js'
import type { LayoutTree, LayoutNode, GroupNode, MonitorNode, PublicMaintenanceWindow, UptimeThresholds } from '@bsp/shared'
import { classifyUptimeDay, DEFAULT_UPTIME_THRESHOLDS } from '@bsp/shared'
import { publishedIncident, withIncidentDetails } from './incidentDetails.js'
import { RESULT_IN_MAINTENANCE } from '../db/resultMarks.js'

/**
 * What visitors of the status page may see. The public routes and the static snapshot both read
 * through here, so a monitor or incident hidden from one is hidden from the other.
 */

function publicIds(links: Array<{ monitorId: number }>, published: ReadonlySet<number>): number[] {
  return links.map((link) => link.monitorId).filter((id) => published.has(id))
}

/** Incidents lose their links to internal monitors before they reach visitors. */
export function publishIncidents<T extends { monitorIds: number[] }>(rows: T[], published: ReadonlySet<number>): T[] {
  return rows.map((row) => ({ ...row, monitorIds: row.monitorIds.filter((id) => published.has(id)) }))
}

export async function loadPublicStatus() {
  const published = await getPublishedMonitorIds()
  const allMonitors = await db.select({
    id: monitors.id,
    name: monitors.name,
    type: monitors.type,
    currentStatus: monitors.currentStatus,
    lastCheckedAt: monitors.lastCheckedAt,
  }).from(monitors)
  const publishedMonitors = allMonitors.filter((monitor) => published.has(monitor.id))
  const rawActiveIncidents = await db.select().from(incidents).where(and(ne(incidents.status, 'resolved'), publishedIncident)).orderBy(desc(incidents.createdAt))
  const activeIncidents = publishIncidents(await withIncidentDetails(rawActiveIncidents), published)
  const brandingRow = (await db.select().from(branding))[0] ?? null

  const now = Date.now()
  const activeWindowRows = await activeWindows(now)
  const windowLinks = activeWindowRows.length
    ? await db.select().from(maintenanceWindowMonitors)
      .where(inArray(maintenanceWindowMonitors.windowId, activeWindowRows.map((win) => win.id)))
    : []
  const windowsWithLinks = activeWindowRows.map((win) => ({ win, links: windowLinks.filter((link) => link.windowId === win.id) }))
  // An empty list means "every monitor", so a window that only covers internal monitors is left
  // out entirely rather than published with its (hidden) links stripped.
  const activeMaintenanceWindows = windowsWithLinks
    .filter(({ links }) => links.length === 0 || links.some((link) => published.has(link.monitorId)))
    .map(({ win, links }): PublicMaintenanceWindow => ({
      id: win.id, name: win.name, description: win.description, startsAt: win.startsAt, endsAt: win.endsAt,
      monitorIds: publicIds(links, published),
    }))

  const publishedDependencies = (await db.select().from(monitorDependencies))
    .filter((dep) => published.has(dep.dependentId) && published.has(dep.dependsOnId))

  return { branding: brandingRow, monitors: publishedMonitors, activeIncidents, activeMaintenanceWindows, monitorDependencies: publishedDependencies }
}

export async function loadPublicLayout() {
  const layoutRow = (await db.select().from(layout))[0]
  const brandingRow = (await db.select().from(branding))[0] ?? null
  let tree: LayoutTree = { id: 'root', type: 'page', children: [] }

  if (layoutRow) {
    try {
      const parsed = JSON.parse(layoutRow.tree) as LayoutTree
      const existingIds = new Set((await db.select().from(monitors)).map((m) => m.id))
      tree = sanitizeTree(parsed, existingIds)
    } catch { /* keep default */ }
  }
  return { tree, branding: brandingRow }
}

export async function loadPublicIncidents(paging: { limit: number; offset: number }) {
  const rows = await db.select().from(incidents).where(publishedIncident).orderBy(desc(incidents.createdAt), desc(incidents.id))
    .limit(paging.limit).offset(paging.offset)
  return publishIncidents(await withIncidentDetails(rows), await getPublishedMonitorIds())
}

export async function loadPublicIncident(incidentId: number) {
  const incident = (await db.select().from(incidents).where(and(eq(incidents.id, incidentId), publishedIncident)))[0]
  if (!incident) return null
  return publishIncidents(await withIncidentDetails([incident]), await getPublishedMonitorIds())[0]!
}

export async function loadPublicLocales() {
  return db.select({ code: locales.code, name: locales.name, isDefault: locales.isDefault }).from(locales).orderBy(locales.name)
}

export async function loadPublicLocale(code: string) {
  const row = (await db.select().from(locales).where(eq(locales.code, code)))[0]
  if (!row) return null
  return { code: row.code, name: row.name, translations: JSON.parse(row.translations || '{}') as Record<string, string> }
}

export async function loadUptime(monitorId: number, days: number) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000
  const brandingRow = (await db.select().from(branding))[0]
  const thresholds: UptimeThresholds = brandingRow ?? DEFAULT_UPTIME_THRESHOLDS
  // Counted per UTC day in SQL: the page only needs totals, not up to 90 days of raw rows.
  // UTC day number (integer division): grouping by it is about twice as fast as formatting a date string per row.
  const day = sql<number>`${monitorResults.checkedAt} / 86400000`
  const dayRows = await db.select({
    date: day,
    checksTotal: countedChecks,
    checksUp: countedUp,
    maintenanceChecks,
  }).from(monitorResults)
    .where(and(eq(monitorResults.monitorId, monitorId), gte(monitorResults.checkedAt, since)))
    .groupBy(day)
  const dayBuckets = new Map(dayRows.map((row) => [Number(row.date), row]))

  // Fetch incidents affecting this specific monitor
  const incidentLinks = await db
    .select({ incidentId: incidentMonitors.incidentId })
    .from(incidentMonitors)
    .where(eq(incidentMonitors.monitorId, monitorId))
  const incidentIds = incidentLinks.map((l) => l.incidentId)
  type IncidentRow = { id: number; title: string; startedAt: number; resolvedAt: number | null }
  let relevantIncidents: IncidentRow[] = []
  if (incidentIds.length > 0) {
    relevantIncidents = await db
      .select({ id: incidents.id, title: incidents.title, startedAt: incidents.startedAt, resolvedAt: incidents.resolvedAt })
      .from(incidents)
      .where(and(inArray(incidents.id, incidentIds), publishedIncident))
  }

  const summaryDays = []
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const bucket = dayBuckets.get(new Date(date + 'T00:00:00.000Z').getTime() / 86_400_000)
    const checksTotal = Number(bucket?.checksTotal ?? 0)
    const checksUp = Number(bucket?.checksUp ?? 0)
    const uptimePct = checksTotal > 0 ? (checksUp / checksTotal) * 100 : 100
    const maintenance = Number(bucket?.maintenanceChecks ?? 0)
    const status = classifyUptimeDay(checksTotal > 0 ? uptimePct : null, thresholds, maintenance > 0)

    // Incidents active on this day (started before end of day, not resolved before start of day)
    const dayStart = new Date(date + 'T00:00:00.000Z').getTime()
    const dayEnd   = dayStart + 86_400_000 - 1
    const dayIncidents = relevantIncidents
      .filter((inc) => inc.startedAt <= dayEnd && (inc.resolvedAt === null || inc.resolvedAt >= dayStart))
      .map((inc) => ({
        id: inc.id,
        title: inc.title,
        durationMs: inc.resolvedAt !== null ? inc.resolvedAt - inc.startedAt : null,
      }))

    summaryDays.push({ date, status, uptimePct, checksTotal, checksUp, maintenanceChecks: maintenance, incidents: dayIncidents })
  }

  const totalChecks = summaryDays.reduce((a, d) => a + d.checksTotal, 0)
  const totalUp = summaryDays.reduce((a, d) => a + d.checksUp, 0)
  const overallUptimePct = totalChecks > 0 ? (totalUp / totalChecks) * 100 : null
  return { monitorId, days: summaryDays, overallUptimePct }
}

/** Response times of one monitor over the last `hours`, in `nBuckets` slices. */
export async function loadHistory(monitorId: number, hours: number, nBuckets: number) {
  const now = Date.now()
  const since = now - hours * 3_600_000

  const results = await db
    .select({ status: monitorResults.status, responseMs: monitorResults.responseMs, checkedAt: monitorResults.checkedAt, unconfirmed: monitorResults.unconfirmed })
    .from(monitorResults)
    .where(and(eq(monitorResults.monitorId, monitorId), gte(monitorResults.checkedAt, since)))
    .orderBy(monitorResults.checkedAt)

  type ResultRow = { status: string; responseMs: number | null; checkedAt: number; unconfirmed: number }
  const bucketSize = (now - since) / nBuckets
  const STATUS_PRIORITY: Record<string, number> = { down: 0, degraded: 1, affected: 2, up: 3, pending: 4 }

  // One pass over the rows instead of filtering the full list once per bucket.
  const grouped: ResultRow[][] = Array.from({ length: nBuckets }, () => [])
  for (const r of results as ResultRow[]) {
    const index = Math.floor((r.checkedAt - since) / bucketSize)
    if (index >= 0 && index < nBuckets) grouped[index]!.push(r)
  }

  const output = grouped.map((bucket, i) => {
    const bucketEnd = since + (i + 1) * bucketSize

    if (bucket.length === 0) {
      return { ts: Math.round(bucketEnd), avg: null, min: null, max: null, p95: null, count: 0, status: null as string | null }
    }

    const times = bucket
      .map((r: ResultRow) => r.responseMs)
      .filter((v): v is number => v !== null)
      .sort((a: number, b: number) => a - b)

    const avg = times.length ? Math.round(times.reduce((a: number, b: number) => a + b, 0) / times.length) : null
    const min = times.length ? times[0]! : null
    const max = times.length ? times[times.length - 1]! : null
    const p95 = times.length ? times[Math.min(Math.floor(times.length * 0.95), times.length - 1)]! : null

    // A failure inside a maintenance window is not an outage; a bucket with nothing else is maintenance.
    const counted = bucket.filter((r) => r.unconfirmed !== RESULT_IN_MAINTENANCE)
    const dominantStatus = counted.length === 0 ? 'maintenance' : counted.reduce((worst: string, r: ResultRow) => {
      return (STATUS_PRIORITY[r.status] ?? 9) < (STATUS_PRIORITY[worst] ?? 9) ? r.status : worst
    }, counted[0]!.status)

    return { ts: Math.round(bucketEnd), avg, min, max, p95, count: bucket.length, status: dominantStatus }
  })

  return { monitorId, hours, buckets: output }
}

function sanitizeTree(node: LayoutTree, validIds: Set<number>): LayoutTree {
  return { ...node, children: sanitizeChildren(node.children, validIds) }
}

function sanitizeChildren(children: LayoutNode[], validIds: Set<number>): LayoutNode[] {
  return children
    .filter((c) => c.type !== 'monitor' || validIds.has((c as MonitorNode).monitorId))
    .map((c) => c.type === 'group'
      ? { ...(c as GroupNode), children: sanitizeChildren((c as GroupNode).children, validIds) }
      : c,
    )
}
