import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { maintenanceWindows, maintenanceWindowMonitors, monitors } from '../db/schema.js'
import { eq, and, lte, gte, inArray } from 'drizzle-orm'
import { auditActor, writeAudit, diffObjects, snapshot } from '../services/audit.js'
import { requestIdentity } from '../middleware/auth.js'
import { notifyMaintenanceSubscribers } from '../workers/subscriberNotifier.js'

async function withMonitorIds(win: typeof maintenanceWindows.$inferSelect) {
  const links = await db.select().from(maintenanceWindowMonitors).where(eq(maintenanceWindowMonitors.windowId, win.id))
  return { ...win, monitorIds: links.map((l) => l.monitorId) }
}

const MAX_NAME_LENGTH = 200
const MAX_MONITOR_IDS = 1_000
const isEpochMs = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/**
 * The first problem with a create or update body, or null. `current` is the stored window of an update, so a body
 * that moves only one end is checked against the other. Fields left out are not checked (an update) or required
 * (a create, where `required` is set).
 */
async function windowProblem(
  body: { name?: unknown; startsAt?: unknown; endsAt?: unknown; description?: unknown; monitorIds?: unknown },
  current: { startsAt: number; endsAt: number } | null,
): Promise<string | null> {
  const required = current === null
  if (body.name !== undefined || required) {
    if (typeof body.name !== 'string' || !body.name.trim()) return 'Name is required'
    if (body.name.length > MAX_NAME_LENGTH) return `Name must be at most ${MAX_NAME_LENGTH} characters`
  }
  for (const field of ['startsAt', 'endsAt'] as const) {
    if ((body[field] !== undefined || required) && !isEpochMs(body[field])) return `${field} must be a timestamp in milliseconds`
  }
  const startsAt = (body.startsAt ?? current?.startsAt) as number
  const endsAt = (body.endsAt ?? current?.endsAt) as number
  if (endsAt <= startsAt) return 'endsAt must be after startsAt'
  if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') return 'description must be text'
  if (body.monitorIds !== undefined) {
    const ids = body.monitorIds
    if (!Array.isArray(ids) || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) return 'monitorIds must be a list of monitor ids'
    if (ids.length > MAX_MONITOR_IDS) return `monitorIds can name at most ${MAX_MONITOR_IDS} monitors`
    const unique = [...new Set(ids as number[])]
    if (unique.length > 0) {
      const known = await db.select({ id: monitors.id }).from(monitors).where(inArray(monitors.id, unique))
      if (known.length !== unique.length) return 'Unknown monitor'
    }
  }
  return null
}

export async function maintenanceRoutes(app: FastifyInstance) {
  // List all maintenance windows
  app.get('/', async () => {
    const rows = await db.select().from(maintenanceWindows)
    return Promise.all(rows.map(withMonitorIds))
  })

  // Get active windows (now is between starts_at and ends_at)
  app.get('/active', async () => {
    const now = Date.now()
    const rows = await db.select().from(maintenanceWindows).where(
      and(lte(maintenanceWindows.startsAt, now), gte(maintenanceWindows.endsAt, now)),
    )
    return Promise.all(rows.map(withMonitorIds))
  })

  // Get single window
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = (await db.select().from(maintenanceWindows).where(eq(maintenanceWindows.id, Number(req.params.id))))[0]
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return withMonitorIds(row)
  })

  // Create window
  app.post<{ Body: {
    name: string
    startsAt: number
    endsAt: number
    description?: string
    monitorIds?: number[]
    notifySubscribers?: boolean
  } }>('/', async (req, reply) => {
    const problem = await windowProblem(req.body ?? {}, null)
    if (problem) return reply.code(400).send({ error: problem })
    const now = Date.now()
    const { name, startsAt, endsAt, description, notifySubscribers = true } = req.body
    const monitorIds = [...new Set(req.body.monitorIds ?? [])]
    const results = await db.insert(maintenanceWindows).values({
      name,
      startsAt,
      endsAt,
      description: description ?? null,
      createdAt: now,
      updatedAt: now,
    }).returning()
    const win = results[0]!
    if (monitorIds.length > 0) {
      await db.insert(maintenanceWindowMonitors).values(
        monitorIds.map((mid) => ({ windowId: win.id, monitorId: mid })),
      )
    }
    const actor = requestIdentity(req)
    writeAudit(auditActor(actor), 'create', 'maintenance', win.id, win.name,
      snapshot({ name: win.name, startsAt: win.startsAt, endsAt: win.endsAt, monitorIds }))
    // Announcing a window that is already over would only be noise.
    if (notifySubscribers && win.endsAt > now) {
      await notifyMaintenanceSubscribers(win.id)
        .catch((error) => console.error('[subscriptions] Failed to queue maintenance notice:', error))
    }
    return withMonitorIds(win)
  })

  // Update window
  app.patch<{ Params: { id: string }; Body: Partial<{
    name: string
    startsAt: number
    endsAt: number
    description: string | null
    monitorIds: number[]
  }> }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(maintenanceWindows).where(eq(maintenanceWindows.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    const problem = await windowProblem(req.body ?? {}, existing)
    if (problem) return reply.code(400).send({ error: problem })

    const updates: Partial<typeof maintenanceWindows.$inferInsert> = { updatedAt: Date.now() }
    if (req.body.name !== undefined) updates.name = req.body.name
    if (req.body.startsAt !== undefined) updates.startsAt = req.body.startsAt
    if (req.body.endsAt !== undefined) updates.endsAt = req.body.endsAt
    if ('description' in req.body) updates.description = req.body.description ?? null

    const results = await db.update(maintenanceWindows).set(updates).where(eq(maintenanceWindows.id, id)).returning()
    const win = results[0]!

    if (req.body.monitorIds !== undefined) {
      await db.delete(maintenanceWindowMonitors).where(eq(maintenanceWindowMonitors.windowId, id))
      if (req.body.monitorIds.length > 0) {
        await db.insert(maintenanceWindowMonitors).values(
          [...new Set(req.body.monitorIds)].map((mid) => ({ windowId: id, monitorId: mid })),
        )
      }
    }

    const actor = requestIdentity(req)
    const before = { name: existing.name, startsAt: existing.startsAt, endsAt: existing.endsAt } as Record<string, unknown>
    const after  = { name: win.name, startsAt: win.startsAt, endsAt: win.endsAt } as Record<string, unknown>
    const diff = diffObjects(before, after)
    if (req.body.monitorIds !== undefined) diff['monitorIds'] = { from: '[previous]', to: req.body.monitorIds }
    if (Object.keys(diff).length) writeAudit(auditActor(actor), 'update', 'maintenance', id, existing.name, diff)
    return withMonitorIds(win)
  })

  // Delete window
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(maintenanceWindows).where(eq(maintenanceWindows.id, id)))[0]
    await db.delete(maintenanceWindows).where(eq(maintenanceWindows.id, id))
    if (existing) {
      const actor = requestIdentity(req)
      writeAudit(auditActor(actor), 'delete', 'maintenance', id, existing.name,
        snapshot({ name: existing.name }))
    }
    return reply.code(204).send()
  })
}
