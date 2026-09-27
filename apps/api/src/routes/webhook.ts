import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { db } from '../db/client.js'
import { monitors } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { recordObservation } from '../workers/scheduler.js'
import { WEBHOOK_RATE_LIMIT } from '../config/rateLimits.js'

async function handleWebhook(req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) {
  const { token } = req.params
  if (!/^[0-9a-f]{48}$/.test(token)) return reply.code(404).send({ error: 'Not found' })
  const row = (await db.select().from(monitors).where(eq(monitors.webhookToken, token)))[0]
  if (!row) return reply.code(404).send({ error: 'Not found' })

  // A heartbeat counts as one successful check, so recoveryThreshold and maintenance windows apply
  // here exactly as they do to scheduled checks. Heartbeats can be frequent, so only a status
  // change is broadcast.
  await recordObservation(row, { status: 'up', responseMs: null, error: null }, { broadcast: 'on-change' })

  return reply.code(200).send({ ok: true })
}

export async function webhookRoutes(app: FastifyInstance) {
  const options = { config: { rateLimit: WEBHOOK_RATE_LIMIT } }
  app.get<{ Params: { token: string } }>('/:token', options, handleWebhook)
  app.post<{ Params: { token: string } }>('/:token', options, handleWebhook)
}
