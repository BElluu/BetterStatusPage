import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { monitorGroups } from '../db/schema.js'
import { eq } from 'drizzle-orm'

export async function groupRoutes(app: FastifyInstance) {
  app.get('/', async () => {
    return db.select().from(monitorGroups)
  })

  app.post<{ Body: { name: string; parentId?: number } }>('/', async (req) => {
    const results = await db.insert(monitorGroups).values({
      name: req.body.name,
      parentId: req.body.parentId ?? null,
      sortOrder: 0,
      createdAt: Date.now(),
    }).returning()
    return results[0]
  })

  app.patch<{ Params: { id: string }; Body: { name?: string; parentId?: number | null; sortOrder?: number } }>(
    '/:id', async (req, reply) => {
      const id = Number(req.params.id)
      const existing = (await db.select().from(monitorGroups).where(eq(monitorGroups.id, id)))[0]
      if (!existing) return reply.code(404).send({ error: 'Not found' })
      const updates: Record<string, unknown> = {}
      if (req.body.name !== undefined) updates['name'] = req.body.name
      if (req.body.parentId !== undefined) updates['parentId'] = req.body.parentId
      if (req.body.sortOrder !== undefined) updates['sortOrder'] = req.body.sortOrder
      const results = await db.update(monitorGroups).set(updates).where(eq(monitorGroups.id, id)).returning()
      return results[0]
    },
  )

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    await db.delete(monitorGroups).where(eq(monitorGroups.id, Number(req.params.id)))
    return reply.code(204).send()
  })
}
