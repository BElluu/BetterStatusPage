import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { db } from '../db/client.js'
import { monitors, monitorResults } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { sseService } from '../services/sse.service.js'

async function handleWebhook(req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) {
  const { token } = req.params
  const row = (await db.select().from(monitors).where(eq(monitors.webhookToken, token)))[0]
  if (!row) return reply.code(404).send({ error: 'Not found' })

  const now = Date.now()
  await db.insert(monitorResults).values({
    monitorId: row.id,
    status: 'up',
    responseMs: null,
    checkedAt: now,
    errorMessage: null,
  })

  const prevStatus = row.currentStatus
  await db.update(monitors)
    .set({ currentStatus: 'up', lastCheckedAt: now, updatedAt: now })
    .where(eq(monitors.id, row.id))

  if (prevStatus !== 'up') {
    sseService.broadcast('monitor.status', { monitorId: row.id, status: 'up', responseMs: null, checkedAt: now })
  }

  return reply.code(200).send({ ok: true })
}

export async function webhookRoutes(app: FastifyInstance) {
  app.get<{ Params: { token: string } }>('/:token', handleWebhook)
  app.post<{ Params: { token: string } }>('/:token', handleWebhook)
}
