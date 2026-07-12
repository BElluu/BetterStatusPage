import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import {
  monitors, incidents, incidentUpdates, incidentMonitors, monitorResults, layout, branding,
  maintenanceWindows, maintenanceWindowMonitors, monitorDependencies,
} from '../db/schema.js'
import { eq, desc, gte, ne, inArray, and, lte } from 'drizzle-orm'
import { sseService } from '../services/sse.service.js'
import type { LayoutTree, LayoutNode, GroupNode, MonitorNode } from '@bsp/shared'
import { PUBLIC_HISTORY_RATE_LIMIT } from '../config/rateLimits.js'

const STATUS_CACHE_TTL_MS = 2_000

function parseInteger(value: string | undefined, fallback: number, min: number, max: number): number | null {
  const parsed = Number(value ?? fallback)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null
}

export async function publicRoutes(app: FastifyInstance) {
  let statusCache: { expiresAt: number; value: Promise<unknown> } | null = null

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
    const allMonitors = await db.select({
      id: monitors.id,
      name: monitors.name,
      type: monitors.type,
      currentStatus: monitors.currentStatus,
      lastCheckedAt: monitors.lastCheckedAt,
    }).from(monitors)
    const rawActiveIncidents = await db.select().from(incidents).where(ne(incidents.status, 'resolved')).orderBy(desc(incidents.createdAt))
    const activeIncidents = await Promise.all(rawActiveIncidents.map(async (incident) => {
      const updates = await db.select().from(incidentUpdates).where(eq(incidentUpdates.incidentId, incident.id)).orderBy(desc(incidentUpdates.postedAt))
      const monitorLinks = await db.select().from(incidentMonitors).where(eq(incidentMonitors.incidentId, incident.id))
      return { ...incident, updates, monitorIds: monitorLinks.map((l) => l.monitorId) }
    }))
    const brandingRow = (await db.select().from(branding))[0] ?? null

    const now = Date.now()
    const activeWindowRows = await db.select().from(maintenanceWindows).where(
      and(lte(maintenanceWindows.startsAt, now), gte(maintenanceWindows.endsAt, now)),
    )
    const activeMaintenanceWindows = await Promise.all(activeWindowRows.map(async (win) => {
      const links = await db.select().from(maintenanceWindowMonitors).where(eq(maintenanceWindowMonitors.windowId, win.id))
      return { ...win, monitorIds: links.map((l) => l.monitorId) }
    }))

    const allDependencies = await db.select().from(monitorDependencies)

    return { branding: brandingRow, monitors: allMonitors, activeIncidents, activeMaintenanceWindows, monitorDependencies: allDependencies }
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
    return Promise.all(all.map(async (incident) => {
      const updates = await db.select().from(incidentUpdates)
        .where(eq(incidentUpdates.incidentId, incident.id)).orderBy(desc(incidentUpdates.postedAt))
      const monitorLinks = await db.select().from(incidentMonitors).where(eq(incidentMonitors.incidentId, incident.id))
      return { ...incident, updates, monitorIds: monitorLinks.map((l) => l.monitorId) }
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
    return { ...incident, updates, monitorIds: monitorLinks.map((l) => l.monitorId) }
  })

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>('/monitor/:id/uptime', {
    config: { rateLimit: PUBLIC_HISTORY_RATE_LIMIT },
  }, async (req, reply) => {
    const days = parseInteger(req.query.days, 90, 1, 90)
    const monitorId = parseInteger(req.params.id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (days === null || monitorId === null) {
      return reply.code(400).send({ error: 'Invalid monitor id or days; days must be between 1 and 90' })
    }
    const monitor = (await db.select({ id: monitors.id }).from(monitors).where(eq(monitors.id, monitorId)))[0]
    if (!monitor) return reply.code(404).send({ error: 'Not found' })
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

      const monitor = (await db.select().from(monitors).where(eq(monitors.id, monitorId)))[0]
      if (!monitor) return reply.code(404).send({ error: 'Not found' })

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

  app.get('/events', async (req, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.setHeader('X-Accel-Buffering', 'no')
    reply.raw.flushHeaders()

    sseService.add(reply)
    reply.raw.write('event: ping\ndata: {}\n\n')

    const pingInterval = setInterval(() => {
      try { reply.raw.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`) }
      catch { clearInterval(pingInterval) }
    }, 30000)

    req.raw.on('close', () => { clearInterval(pingInterval); sseService.remove(reply) })
    await new Promise<void>((resolve) => { req.raw.on('close', resolve) })
  })
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
