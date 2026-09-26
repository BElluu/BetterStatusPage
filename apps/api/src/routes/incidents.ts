import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { incidents, incidentUpdates, incidentMonitors } from '../db/schema.js'
import { eq, desc } from 'drizzle-orm'
import { sseService } from '../services/sse.service.js'
import { writeAudit, diffObjects, snapshot } from '../services/audit.js'
import { notifyIncidentSubscribers } from '../workers/subscriberNotifier.js'

const VALID_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const
const VALID_IMPACTS = ['minor', 'major', 'critical'] as const

/** Subscriber fan-out must never fail the operator action that triggered it. */
async function noticeSubscribers(work: () => Promise<unknown>): Promise<void> {
  try { await work() } catch (error) { console.error('[subscriptions] Failed to queue incident notice:', error) }
}

function parseMonitorIds(value: unknown): number[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((id) => Number.isInteger(id) && id > 0)) return null
  return [...new Set(value as number[])]
}

async function enrichIncident(incident: typeof incidents.$inferSelect) {
  const updates = await db.select().from(incidentUpdates)
    .where(eq(incidentUpdates.incidentId, incident.id))
    .orderBy(desc(incidentUpdates.postedAt))

  const monitorLinks = await db.select().from(incidentMonitors)
    .where(eq(incidentMonitors.incidentId, incident.id))

  return {
    ...incident,
    updates,
    monitorIds: monitorLinks.map((l) => l.monitorId),
  }
}

export async function incidentRoutes(app: FastifyInstance) {
  app.get('/', async () => {
    const all = await db.select().from(incidents).orderBy(desc(incidents.createdAt))
    return Promise.all(all.map(enrichIncident))
  })

  app.post<{ Body: { title: string; status?: string; impact?: string; startedAt?: number; monitorIds?: number[]; notifySubscribers?: boolean } }>('/', async (req, reply) => {
    const status = req.body.status ?? 'investigating'
    const impact = req.body.impact ?? 'minor'
    if (!VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
      return reply.code(400).send({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` })
    }
    if (!VALID_IMPACTS.includes(impact as typeof VALID_IMPACTS[number])) {
      return reply.code(400).send({ error: `Invalid impact. Must be one of: ${VALID_IMPACTS.join(', ')}` })
    }
    const monitorIds = parseMonitorIds(req.body.monitorIds)
    if (monitorIds === null) return reply.code(400).send({ error: 'monitorIds must be an array of monitor ids' })
    const now = Date.now()
    const results = await db.insert(incidents).values({
      title: req.body.title,
      status,
      impact,
      startedAt: req.body.startedAt ?? now,
      createdAt: now,
      updatedAt: now,
    }).returning()
    const incident = results[0]!
    // Linked in the same request so component-scoped subscribers are matched on creation.
    if (monitorIds.length > 0) {
      await db.insert(incidentMonitors).values(monitorIds.map((monitorId) => ({ incidentId: incident.id, monitorId })))
    }
    const enriched = await enrichIncident(incident)
    sseService.broadcast('incident.created', enriched)
    if (req.body.notifySubscribers !== false) await noticeSubscribers(() => notifyIncidentSubscribers('incident.created', incident.id))
    const actor = req.user as { userId: number; email: string }
    writeAudit({ userId: actor.userId, userEmail: actor.email }, 'create', 'incident', incident.id, incident.title,
      snapshot({ title: incident.title, status: incident.status, impact: incident.impact }))
    return enriched
  })

  app.patch<{ Params: { id: string }; Body: Partial<{ title: string; status: string; impact: string; resolvedAt: number | null; notifySubscribers: boolean }> }>(
    '/:id', async (req, reply) => {
      const id = Number(req.params.id)
      const existing = (await db.select().from(incidents).where(eq(incidents.id, id)))[0]
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      if (req.body.status !== undefined && !VALID_STATUSES.includes(req.body.status as typeof VALID_STATUSES[number])) {
        return reply.code(400).send({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` })
      }
      if (req.body.impact !== undefined && !VALID_IMPACTS.includes(req.body.impact as typeof VALID_IMPACTS[number])) {
        return reply.code(400).send({ error: `Invalid impact. Must be one of: ${VALID_IMPACTS.join(', ')}` })
      }
      const updates: Record<string, unknown> = { updatedAt: Date.now() }
      if (req.body.title !== undefined) updates['title'] = req.body.title
      if (req.body.status !== undefined) updates['status'] = req.body.status
      if (req.body.impact !== undefined) updates['impact'] = req.body.impact
      if (req.body.resolvedAt !== undefined) updates['resolvedAt'] = req.body.resolvedAt

      const results = await db.update(incidents).set(updates).where(eq(incidents.id, id)).returning()
      const enriched = await enrichIncident(results[0]!)
      sseService.broadcast('incident.updated', enriched)
      const actor = req.user as { userId: number; email: string }
      const before = { title: existing.title, status: existing.status, impact: existing.impact } as Record<string, unknown>
      const after  = { title: results[0]!.title, status: results[0]!.status, impact: results[0]!.impact } as Record<string, unknown>
      const diff = diffObjects(before, after)
      if (Object.keys(diff).length) writeAudit({ userId: actor.userId, userEmail: actor.email }, 'update', 'incident', id, existing.title, diff)
      if (existing.status !== 'resolved' && results[0]!.status === 'resolved' && req.body.notifySubscribers !== false) {
        await noticeSubscribers(() => notifyIncidentSubscribers('incident.resolved', id))
      }
      return enriched
    },
  )

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(incidents).where(eq(incidents.id, id)))[0]
    await db.delete(incidents).where(eq(incidents.id, id))
    if (existing) {
      const actor = req.user as { userId: number; email: string }
      writeAudit({ userId: actor.userId, userEmail: actor.email }, 'delete', 'incident', id, existing.title,
        snapshot({ title: existing.title, impact: existing.impact }))
    }
    return reply.code(204).send()
  })

  app.post<{ Params: { id: string }; Body: { body: string; status: string; notifySubscribers?: boolean } }>(
    '/:id/updates', async (req, reply) => {
      if (!VALID_STATUSES.includes(req.body.status as typeof VALID_STATUSES[number])) {
        return reply.code(400).send({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` })
      }
      const incidentId = Number(req.params.id)
      const existing = (await db.select().from(incidents).where(eq(incidents.id, incidentId)))[0]
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      const updateResults = await db.insert(incidentUpdates).values({
        incidentId,
        body: req.body.body,
        status: req.body.status,
        postedAt: Date.now(),
      }).returning()

      await db.update(incidents).set({
        status: req.body.status,
        updatedAt: Date.now(),
        resolvedAt: req.body.status === 'resolved' ? Date.now() : existing.resolvedAt,
      }).where(eq(incidents.id, incidentId))

      const updatedIncident = (await db.select().from(incidents).where(eq(incidents.id, incidentId)))[0]!
      const enriched = await enrichIncident(updatedIncident)
      sseService.broadcast('incident.updated', enriched)
      if (req.body.notifySubscribers !== false) {
        const update = updateResults[0]!
        const type = update.status === 'resolved' && existing.status !== 'resolved' ? 'incident.resolved' : 'incident.updated'
        await noticeSubscribers(() => notifyIncidentSubscribers(type, incidentId, { body: update.body, status: update.status, postedAt: update.postedAt }))
      }
      return updateResults[0]
    },
  )

  app.post<{ Params: { id: string }; Body: { monitorIds: number[] } }>(
    '/:id/monitors', async (req, reply) => {
      const incidentId = Number(req.params.id)
      const existing = (await db.select().from(incidents).where(eq(incidents.id, incidentId)))[0]
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      await db.delete(incidentMonitors).where(eq(incidentMonitors.incidentId, incidentId))
      for (const monitorId of req.body.monitorIds) {
        await db.insert(incidentMonitors).values({ incidentId, monitorId })
      }
      return enrichIncident(existing)
    },
  )
}
