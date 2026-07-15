import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { isSetupComplete } from '../config.js'
import { db } from '../db/client.js'

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ status: 'ok' }))

  app.get('/ready', async (_req, reply) => {
    if (!isSetupComplete()) {
      return reply.code(503).send({ status: 'not_ready' })
    }
    try {
      await db.run(sql`SELECT 1`)
      return { status: 'ready' }
    } catch {
      return reply.code(503).send({ status: 'not_ready' })
    }
  })
}
