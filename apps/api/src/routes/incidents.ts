import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { incidents, incidentUpdates, incidentMonitors } from '../db/schema.js'
import { eq, desc } from 'drizzle-orm'
import { sseService } from '../services/sse.service.js'

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

  app.post<{ Body: { title: string; status?: string; impact?: string; startedAt?: number } }>('/', async (req) => {
    const now = Date.now()
    const results = await db.insert(incidents).values({
      title: req.body.title,
      status: req.body.status ?? 'investigating',
      impact: req.body.impact ?? 'minor',
      startedAt: req.body.startedAt ?? now,
      createdAt: now,
      updatedAt: now,
    }).returning()
    const incident = results[0]!
    const enriched = await enrichIncident(incident)
    sseService.broadcast('incident.created', enriched)
    return enriched
  })

  app.patch<{ Params: { id: string }; Body: Partial<{ title: string; status: string; impact: string; resolvedAt: number | null }> }>(
    '/:id', async (req, reply) => {
      const id = Number(req.params.id)
      const existing = (await db.select().from(incidents).where(eq(incidents.id, id)))[0]
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      const updates: Record<string, unknown> = { updatedAt: Date.now() }
      if (req.body.title !== undefined) updates['title'] = req.body.title
      if (req.body.status !== undefined) updates['status'] = req.body.status
      if (req.body.impact !== undefined) updates['impact'] = req.body.impact
      if (req.body.resolvedAt !== undefined) updates['resolvedAt'] = req.body.resolvedAt

      const results = await db.update(incidents).set(updates).where(eq(incidents.id, id)).returning()
      const enriched = await enrichIncident(results[0]!)
      sseService.broadcast('incident.updated', enriched)
      return enriched
    },
  )

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    await db.delete(incidents).where(eq(incidents.id, Number(req.params.id)))
    return reply.code(204).send()
  })

  app.post<{ Params: { id: string }; Body: { body: string; status: string } }>(
    '/:id/updates', async (req, reply) => {
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
