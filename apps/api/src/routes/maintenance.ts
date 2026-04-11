import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { maintenanceWindows, maintenanceWindowMonitors } from '../db/schema.js'
import { eq, and, lte, gte } from 'drizzle-orm'
import { writeAudit, diffObjects, snapshot } from '../services/audit.js'

async function withMonitorIds(win: typeof maintenanceWindows.$inferSelect) {
  const links = await db.select().from(maintenanceWindowMonitors).where(eq(maintenanceWindowMonitors.windowId, win.id))
  return { ...win, monitorIds: links.map((l) => l.monitorId) }
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
  } }>('/', async (req) => {
    const now = Date.now()
    const { name, startsAt, endsAt, description, monitorIds = [] } = req.body
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
    const actor = req.user as { userId: number; email: string }
    writeAudit({ userId: actor.userId, userEmail: actor.email }, 'create', 'maintenance', win.id, win.name,
      snapshot({ name: win.name, startsAt: win.startsAt, endsAt: win.endsAt, monitorIds }))
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
          req.body.monitorIds.map((mid) => ({ windowId: id, monitorId: mid })),
        )
      }
    }

    const actor = req.user as { userId: number; email: string }
    const before = { name: existing.name, startsAt: existing.startsAt, endsAt: existing.endsAt } as Record<string, unknown>
    const after  = { name: win.name, startsAt: win.startsAt, endsAt: win.endsAt } as Record<string, unknown>
    const diff = diffObjects(before, after)
    if (req.body.monitorIds !== undefined) diff['monitorIds'] = { from: '[previous]', to: req.body.monitorIds }
    if (Object.keys(diff).length) writeAudit({ userId: actor.userId, userEmail: actor.email }, 'update', 'maintenance', id, existing.name, diff)
    return withMonitorIds(win)
  })

  // Delete window
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(maintenanceWindows).where(eq(maintenanceWindows.id, id)))[0]
    await db.delete(maintenanceWindows).where(eq(maintenanceWindows.id, id))
    if (existing) {
      const actor = req.user as { userId: number; email: string }
      writeAudit({ userId: actor.userId, userEmail: actor.email }, 'delete', 'maintenance', id, existing.name,
        snapshot({ name: existing.name }))
    }
    return reply.code(204).send()
  })
}
