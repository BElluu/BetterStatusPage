import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import {
  monitors, monitorGroups, incidents, incidentUpdates, incidentMonitors, monitorResults, layout, branding,
} from '../db/schema.js'
import { eq, desc, gte, ne } from 'drizzle-orm'
import { sseService } from '../services/sse.service.js'
import type { LayoutTree, LayoutNode, GroupNode, MonitorNode } from '@bsp/shared'

export async function publicRoutes(app: FastifyInstance) {
  app.get('/status', async () => {
    const allMonitors = (await db.select().from(monitors)).map((m) => ({ ...m, config: undefined }))
    const allGroups = await db.select().from(monitorGroups)
    const activeIncidents = await db.select().from(incidents).where(ne(incidents.status, 'resolved')).orderBy(desc(incidents.createdAt))
    const brandingRow = (await db.select().from(branding))[0] ?? null
    return { branding: brandingRow, groups: allGroups, monitors: allMonitors, activeIncidents }
  })

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

  app.get<{ Querystring: { page?: string; limit?: string } }>('/incidents', async (req) => {
    const page = Number(req.query.page ?? 1)
    const limit = Number(req.query.limit ?? 10)
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
    const incident = (await db.select().from(incidents).where(eq(incidents.id, Number(req.params.id))))[0]
    if (!incident) return reply.code(404).send({ error: 'Not found' })
    const updates = await db.select().from(incidentUpdates)
      .where(eq(incidentUpdates.incidentId, incident.id)).orderBy(desc(incidentUpdates.postedAt))
    const monitorLinks = await db.select().from(incidentMonitors).where(eq(incidentMonitors.incidentId, incident.id))
    return { ...incident, updates, monitorIds: monitorLinks.map((l) => l.monitorId) }
  })

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>('/monitor/:id/uptime', async (req) => {
    const days = Number(req.query.days ?? 90)
    const since = Date.now() - days * 24 * 60 * 60 * 1000
    const monitorId = Number(req.params.id)
    const results = await db.select().from(monitorResults).where(gte(monitorResults.checkedAt, since))
    const filtered = results.filter((r) => r.monitorId === monitorId)

    const dayBuckets: Record<string, typeof filtered> = {}
    for (const r of filtered) {
      const date = new Date(r.checkedAt).toISOString().slice(0, 10)
      if (!dayBuckets[date]) dayBuckets[date] = []
      dayBuckets[date]!.push(r)
    }

    const summaryDays = []
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const bucket = dayBuckets[date] ?? []
      const checksTotal = bucket.length
      const checksUp = bucket.filter((r) => r.status === 'up').length
      const uptimePct = checksTotal > 0 ? (checksUp / checksTotal) * 100 : 100
      const status = checksTotal === 0 ? 'no-data' : checksUp === checksTotal ? 'up' : checksUp === 0 ? 'down' : 'degraded'
      summaryDays.push({ date, status, uptimePct, checksTotal, checksUp })
    }

    const totalChecks = summaryDays.reduce((a, d) => a + d.checksTotal, 0)
    const totalUp = summaryDays.reduce((a, d) => a + d.checksUp, 0)
    const overallUptimePct = totalChecks > 0 ? (totalUp / totalChecks) * 100 : 100
    return { monitorId, days: summaryDays, overallUptimePct }
  })

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
