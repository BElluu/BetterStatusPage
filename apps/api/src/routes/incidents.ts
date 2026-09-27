import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { incidents, incidentUpdates, incidentMonitors, monitors } from '../db/schema.js'
import { eq, desc, inArray } from 'drizzle-orm'
import { sseService } from '../services/sse.service.js'
import { auditActor, writeAudit, diffObjects, snapshot } from '../services/audit.js'
import { requestIdentity } from '../middleware/auth.js'
import { notifyIncidentSubscribers } from '../workers/subscriberNotifier.js'
import { withIncidentDetails } from '../services/incidentDetails.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { parsePagination } from '../lib/pagination.js'

const VALID_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const
const VALID_IMPACTS = ['minor', 'major', 'critical'] as const
const LIST_DEFAULT_LIMIT = 50
const LIST_MAX_LIMIT = 500

/** Subscriber fan-out must never fail the operator action that triggered it. */
async function noticeSubscribers(work: () => Promise<unknown>): Promise<void> {
  try { await work() } catch (error) { console.error('[subscriptions] Failed to queue incident notice:', error) }
}

function parseMonitorIds(value: unknown): number[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((id) => Number.isInteger(id) && id > 0)) return null
  return [...new Set(value as number[])]
}

/**
 * resolvedAt always follows the status: an incident that is not resolved has none, and one that
 * becomes resolved is stamped now (or with the operator's explicit time). One that was already
 * resolved keeps its original time.
 */
function resolvedAtFor(
  status: string,
  previous: { status: string; resolvedAt: number | null } | null,
  now: number,
  requested?: number | null,
): number | null {
  if (status !== 'resolved') return null
  if (typeof requested === 'number') return requested
  if (previous?.status === 'resolved' && previous.resolvedAt !== null) return previous.resolvedAt
  return now
}

async function enrichIncident(incident: typeof incidents.$inferSelect) {
  return (await withIncidentDetails([incident]))[0]!
}

export async function incidentRoutes(app: FastifyInstance) {
  // Without page/limit the whole list is returned, as the admin panel expects.
  app.get<{ Querystring: { page?: string; limit?: string } }>('/', async (req) => {
    const query = db.select().from(incidents).orderBy(desc(incidents.createdAt), desc(incidents.id))
    if (req.query.page === undefined && req.query.limit === undefined) return withIncidentDetails(await query)
    const { limit, offset } = parsePagination(req.query, { defaultLimit: LIST_DEFAULT_LIMIT, maxLimit: LIST_MAX_LIMIT })
    return withIncidentDetails(await query.limit(limit).offset(offset))
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
      resolvedAt: resolvedAtFor(status, null, now),
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
    const actor = requestIdentity(req)
    writeAudit(auditActor(actor), 'create', 'incident', incident.id, incident.title,
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
      if (req.body.resolvedAt !== undefined && req.body.resolvedAt !== null
        && !(Number.isInteger(req.body.resolvedAt) && req.body.resolvedAt > 0)) {
        return reply.code(400).send({ error: 'resolvedAt must be a timestamp in milliseconds or null' })
      }
      const now = Date.now()
      const updates: Record<string, unknown> = { updatedAt: now }
      if (req.body.title !== undefined) updates['title'] = req.body.title
      if (req.body.status !== undefined) updates['status'] = req.body.status
      if (req.body.impact !== undefined) updates['impact'] = req.body.impact
      updates['resolvedAt'] = resolvedAtFor(req.body.status ?? existing.status, existing, now, req.body.resolvedAt)

      const results = await db.update(incidents).set(updates).where(eq(incidents.id, id)).returning()
      const enriched = await enrichIncident(results[0]!)
      sseService.broadcast('incident.updated', enriched)
      const actor = requestIdentity(req)
      const before = { title: existing.title, status: existing.status, impact: existing.impact } as Record<string, unknown>
      const after  = { title: results[0]!.title, status: results[0]!.status, impact: results[0]!.impact } as Record<string, unknown>
      const diff = diffObjects(before, after)
      if (Object.keys(diff).length) writeAudit(auditActor(actor), 'update', 'incident', id, existing.title, diff)
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
      const actor = requestIdentity(req)
      writeAudit(auditActor(actor), 'delete', 'incident', id, existing.title,
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

      const now = Date.now()
      const updateResults = await db.insert(incidentUpdates).values({
        incidentId,
        body: req.body.body,
        status: req.body.status,
        postedAt: now,
      }).returning()

      await db.update(incidents).set({
        status: req.body.status,
        updatedAt: now,
        resolvedAt: resolvedAtFor(req.body.status, existing, now),
      }).where(eq(incidents.id, incidentId))

      const updatedIncident = (await db.select().from(incidents).where(eq(incidents.id, incidentId)))[0]!
      const enriched = await enrichIncident(updatedIncident)
      sseService.broadcast('incident.updated', enriched)
      const actor = requestIdentity(req)
      const diff = diffObjects({ status: existing.status }, { status: updatedIncident.status })
      if (Object.keys(diff).length) writeAudit(auditActor(actor), 'update', 'incident', incidentId, existing.title, diff)
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

      // Validated in full before anything is removed, so a bad request leaves the links untouched.
      const requested = req.body?.monitorIds === undefined ? null : parseMonitorIds(req.body.monitorIds)
      if (requested === null) return reply.code(400).send({ error: 'monitorIds must be an array of monitor ids' })
      // Ids of monitors that no longer exist are dropped, as with monitor dependencies.
      const monitorIds = requested.length
        ? (await db.select({ id: monitors.id }).from(monitors).where(inArray(monitors.id, requested))).map((m) => m.id)
        : []

      await withImmediateTransaction(async () => {
        await db.delete(incidentMonitors).where(eq(incidentMonitors.incidentId, incidentId))
        if (monitorIds.length > 0) {
          await db.insert(incidentMonitors).values(monitorIds.map((monitorId) => ({ incidentId, monitorId })))
        }
      })
      return enrichIncident(existing)
    },
  )
}
