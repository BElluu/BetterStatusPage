import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import {
  monitors, incidents, incidentUpdates, incidentMonitors, monitorResults, layout, branding,
  maintenanceWindows, maintenanceWindowMonitors, monitorDependencies,
} from '../db/schema.js'
import { eq, desc, gte, ne, inArray, and, lte } from 'drizzle-orm'
import { serveEventStream, sseService } from '../services/sse.service.js'
import { getPublishedMonitorIds, publishedMonitorIdsSnapshot } from '../services/publishedMonitors.js'
import type { LayoutTree, LayoutNode, GroupNode, MonitorNode } from '@bsp/shared'
import { PUBLIC_HISTORY_RATE_LIMIT } from '../config/rateLimits.js'

const STATUS_CACHE_TTL_MS = 2_000

function parseInteger(value: string | undefined, fallback: number, min: number, max: number): number | null {
  const parsed = Number(value ?? fallback)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null
}

export async function publicRoutes(app: FastifyInstance) {
  let statusCache: { expiresAt: number; value: Promise<unknown> } | null = null
  // Clients refetch the status as soon as an incident event arrives; a cached copy from just
  // before the change would hide it from them until the next periodic refresh.
  const stopListening = sseService.onBroadcast((event) => {
    if (event.startsWith('incident.')) statusCache = null
  })
  app.addHook('onClose', async () => { stopListening() })

  app.get('/status', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=2, stale-while-revalidate=5')
    const now = Date.now()
    if (statusCache && statusCache.expiresAt > now) return statusCache.value

    const value = loadPublicStatus()
    statusCache = { expiresAt: now + STATUS_CACHE_TTL_MS, value }
    value.catch(() => {
      if (statusCache?.value === value) statusCache = null
    })
    return value
  })

  async function loadPublicStatus() {
    const published = await getPublishedMonitorIds()
    const allMonitors = await db.select({
      id: monitors.id,
      name: monitors.name,
      type: monitors.type,
      currentStatus: monitors.currentStatus,
      lastCheckedAt: monitors.lastCheckedAt,
    }).from(monitors)
    const publishedMonitors = allMonitors.filter((monitor) => published.has(monitor.id))
    const rawActiveIncidents = await db.select().from(incidents).where(ne(incidents.status, 'resolved')).orderBy(desc(incidents.createdAt))
    const activeIncidents = await Promise.all(rawActiveIncidents.map(async (incident) => {
      const updates = await db.select().from(incidentUpdates).where(eq(incidentUpdates.incidentId, incident.id)).orderBy(desc(incidentUpdates.postedAt))
      const monitorLinks = await db.select().from(incidentMonitors).where(eq(incidentMonitors.incidentId, incident.id))
      return { ...incident, updates, monitorIds: publicIds(monitorLinks, published) }
    }))
    const brandingRow = (await db.select().from(branding))[0] ?? null

    const now = Date.now()
    const activeWindowRows = await db.select().from(maintenanceWindows).where(
      and(lte(maintenanceWindows.startsAt, now), gte(maintenanceWindows.endsAt, now)),
    )
    const windowsWithLinks = await Promise.all(activeWindowRows.map(async (win) => {
      const links = await db.select().from(maintenanceWindowMonitors).where(eq(maintenanceWindowMonitors.windowId, win.id))
      return { win, links }
    }))
    // An empty list means "every monitor", so a window that only covers internal monitors is left
    // out entirely rather than published with its (hidden) links stripped.
    const activeMaintenanceWindows = windowsWithLinks
      .filter(({ links }) => links.length === 0 || links.some((link) => published.has(link.monitorId)))
      .map(({ win, links }) => ({ ...win, monitorIds: publicIds(links, published) }))

    const publishedDependencies = (await db.select().from(monitorDependencies))
      .filter((dep) => published.has(dep.dependentId) && published.has(dep.dependsOnId))

    return { branding: brandingRow, monitors: publishedMonitors, activeIncidents, activeMaintenanceWindows, monitorDependencies: publishedDependencies }
  }

  app.get('/layout', async () => {
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
  })

  app.get<{ Querystring: { page?: string; limit?: string } }>('/incidents', async (req, reply) => {
    const page = parseInteger(req.query.page, 1, 1, 100_000)
    const limit = parseInteger(req.query.limit, 10, 1, 100)
    if (page === null || limit === null) {
      return reply.code(400).send({ error: 'page must be a positive integer and limit must be between 1 and 100' })
    }
    const offset = (page - 1) * limit

    const all = await db.select().from(incidents).orderBy(desc(incidents.createdAt)).limit(limit).offset(offset)
    const published = await getPublishedMonitorIds()
    return Promise.all(all.map(async (incident) => {
      const updates = await db.select().from(incidentUpdates)
        .where(eq(incidentUpdates.incidentId, incident.id)).orderBy(desc(incidentUpdates.postedAt))
      const monitorLinks = await db.select().from(incidentMonitors).where(eq(incidentMonitors.incidentId, incident.id))
      return { ...incident, updates, monitorIds: publicIds(monitorLinks, published) }
    }))
  })

  app.get<{ Params: { id: string } }>('/incidents/:id', async (req, reply) => {
    const incidentId = parseInteger(req.params.id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (incidentId === null) return reply.code(400).send({ error: 'Invalid incident id' })
    const incident = (await db.select().from(incidents).where(eq(incidents.id, incidentId)))[0]
    if (!incident) return reply.code(404).send({ error: 'Not found' })
    const updates = await db.select().from(incidentUpdates)
      .where(eq(incidentUpdates.incidentId, incident.id)).orderBy(desc(incidentUpdates.postedAt))
    const monitorLinks = await db.select().from(incidentMonitors).where(eq(incidentMonitors.incidentId, incident.id))
    return { ...incident, updates, monitorIds: publicIds(monitorLinks, await getPublishedMonitorIds()) }
  })

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>('/monitor/:id/uptime', {
    config: { rateLimit: PUBLIC_HISTORY_RATE_LIMIT },
  }, async (req, reply) => {
    const days = parseInteger(req.query.days, 90, 1, 90)
    const monitorId = parseInteger(req.params.id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (days === null || monitorId === null) {
      return reply.code(400).send({ error: 'Invalid monitor id or days; days must be between 1 and 90' })
    }
    if (!(await getPublishedMonitorIds()).has(monitorId)) return reply.code(404).send({ error: 'Not found' })
    const since = Date.now() - days * 24 * 60 * 60 * 1000
    const filtered = await db.select().from(monitorResults).where(
      and(eq(monitorResults.monitorId, monitorId), gte(monitorResults.checkedAt, since)),
    )

    const dayBuckets: Record<string, typeof filtered> = {}
    for (const r of filtered) {
      const date = new Date(r.checkedAt).toISOString().slice(0, 10)
      if (!dayBuckets[date]) dayBuckets[date] = []
      dayBuckets[date]!.push(r)
    }

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
        .where(inArray(incidents.id, incidentIds))
    }

    const summaryDays = []
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const bucket = dayBuckets[date] ?? []
      const checksTotal = bucket.length
      const checksUp = bucket.filter((r) => r.status === 'up').length
      const uptimePct = checksTotal > 0 ? (checksUp / checksTotal) * 100 : 100
      const status = checksTotal === 0 ? 'no-data' : checksUp === checksTotal ? 'up' : checksUp === 0 ? 'down' : 'degraded'

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

      summaryDays.push({ date, status, uptimePct, checksTotal, checksUp, incidents: dayIncidents })
    }

    const totalChecks = summaryDays.reduce((a, d) => a + d.checksTotal, 0)
    const totalUp = summaryDays.reduce((a, d) => a + d.checksUp, 0)
    const overallUptimePct = totalChecks > 0 ? (totalUp / totalChecks) * 100 : null
    return { monitorId, days: summaryDays, overallUptimePct }
  })

  app.get<{ Params: { id: string }; Querystring: { hours?: string; buckets?: string } }>(
    '/monitor/:id/history',
    { config: { rateLimit: PUBLIC_HISTORY_RATE_LIMIT } },
    async (req, reply) => {
      const monitorId = parseInteger(req.params.id, 0, 1, Number.MAX_SAFE_INTEGER)
      const hours = parseInteger(req.query.hours, 24, 1, 168)
      const nBuckets = parseInteger(req.query.buckets, 30, 10, 100)
      if (monitorId === null || hours === null || nBuckets === null) {
        return reply.code(400).send({ error: 'Invalid monitor id, hours, or buckets' })
      }

      if (!(await getPublishedMonitorIds()).has(monitorId)) return reply.code(404).send({ error: 'Not found' })

      const now   = Date.now()
      const since = now - hours * 3_600_000

      const results = await db
        .select({ status: monitorResults.status, responseMs: monitorResults.responseMs, checkedAt: monitorResults.checkedAt })
        .from(monitorResults)
        .where(and(eq(monitorResults.monitorId, monitorId), gte(monitorResults.checkedAt, since)))
        .orderBy(monitorResults.checkedAt)

      type ResultRow = { status: string; responseMs: number | null; checkedAt: number }
      const bucketSize = (now - since) / nBuckets
      const STATUS_PRIORITY: Record<string, number> = { down: 0, degraded: 1, affected: 2, up: 3, pending: 4 }

      const output = Array.from({ length: nBuckets }, (_, i) => {
        const bucketStart = since + i * bucketSize
        const bucketEnd   = bucketStart + bucketSize
        const bucket: ResultRow[] = results.filter((r: ResultRow) => r.checkedAt >= bucketStart && r.checkedAt < bucketEnd)

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

        const dominantStatus = bucket.reduce((worst: string, r: ResultRow) => {
          return (STATUS_PRIORITY[r.status] ?? 9) < (STATUS_PRIORITY[worst] ?? 9) ? r.status : worst
        }, bucket[0]!.status)

        return { ts: Math.round(bucketEnd), avg, min, max, p95, count: bucket.length, status: dominantStatus }
      })

      return { monitorId, hours, buckets: output }
    },
  )

  // Visitors only hear about published monitors; the admin panel has its own authenticated stream.
  app.get('/events', async (req, reply) => {
    await getPublishedMonitorIds()
    await serveEventStream(req, reply, publicEventFilter)
  })
}

function publicIds(links: Array<{ monitorId: number }>, published: ReadonlySet<number>): number[] {
  return links.map((link) => link.monitorId).filter((id) => published.has(id))
}

/**
 * Status changes of internal monitors are not sent at all, and incident events lose their links to
 * internal monitors. The status page only uses incident events as a cue to refetch.
 */
function publicEventFilter(event: string, data: unknown): { data: unknown } | null {
  const published = publishedMonitorIdsSnapshot()
  if (event === 'monitor.status') {
    return published.has((data as { monitorId: number }).monitorId) ? { data } : null
  }
  if (event.startsWith('incident.') && data && typeof data === 'object' && Array.isArray((data as { monitorIds?: unknown }).monitorIds)) {
    const incident = data as { monitorIds: number[] }
    return { data: { ...incident, monitorIds: incident.monitorIds.filter((id) => published.has(id)) } }
  }
  return { data }
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
