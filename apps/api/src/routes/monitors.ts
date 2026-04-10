import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'crypto'
import { db } from '../db/client.js'
import { monitors, monitorResults } from '../db/schema.js'
import { eq, desc, gte, and } from 'drizzle-orm'
import { runCheck } from '../workers/scheduler.js'
import { testHttps, testSqlServer } from '../workers/testRunner.js'
import type { HttpsConfig, SqlServerConfig } from '@bsp/shared'

function generateWebhookToken(): string {
  return randomBytes(24).toString('hex')
}

export async function monitorRoutes(app: FastifyInstance) {
  app.get('/', async () => {
    const rows = await db.select().from(monitors)
    return rows.map((m) => ({ ...m, config: JSON.parse(m.config) }))
  })

  app.post<{ Body: {
    name: string; type: string
    intervalSecs?: number; timeoutMs?: number; retries?: number; config: unknown
  } }>('/', async (req) => {
    const now = Date.now()
    const results = await db.insert(monitors).values({
      name: req.body.name,
      type: req.body.type,
      intervalSecs: req.body.intervalSecs ?? 60,
      timeoutMs: req.body.timeoutMs ?? 10000,
      retries: req.body.retries ?? 1,
      config: JSON.stringify(req.body.config ?? {}),
      currentStatus: 'pending',
      webhookToken: req.body.type === 'webhook' ? generateWebhookToken() : null,
      createdAt: now,
      updatedAt: now,
    }).returning()
    const result = results[0]!
    return { ...result, config: JSON.parse(result.config) }
  })

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const rows = await db.select().from(monitors).where(eq(monitors.id, Number(req.params.id)))
    const monitor = rows[0]
    if (!monitor) return reply.code(404).send({ error: 'Not found' })
    return { ...monitor, config: JSON.parse(monitor.config) }
  })

  app.patch<{ Params: { id: string }; Body: Partial<{
    name: string; type: string
    intervalSecs: number; timeoutMs: number; retries: number; config: unknown
  }> }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(monitors).where(eq(monitors.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const updates: Record<string, unknown> = { updatedAt: Date.now() }
    if (req.body.name !== undefined) updates['name'] = req.body.name
    if (req.body.type !== undefined) updates['type'] = req.body.type
    if (req.body.intervalSecs !== undefined) updates['intervalSecs'] = req.body.intervalSecs
    if (req.body.timeoutMs !== undefined) updates['timeoutMs'] = req.body.timeoutMs
    if (req.body.retries !== undefined) updates['retries'] = req.body.retries
    if (req.body.config !== undefined) updates['config'] = JSON.stringify(req.body.config)

    const results = await db.update(monitors).set(updates).where(eq(monitors.id, id)).returning()
    const result = results[0]!
    return { ...result, config: JSON.parse(result.config) }
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    await db.delete(monitors).where(eq(monitors.id, Number(req.params.id)))
    return reply.code(204).send()
  })

  app.post<{ Body: { type: string; config: unknown; timeoutMs?: number } }>('/test', async (req, reply) => {
    const { type, config, timeoutMs = 10000 } = req.body
    if (type === 'https') return testHttps(config as HttpsConfig, timeoutMs)
    if (type === 'sqlserver') return testSqlServer(config as SqlServerConfig, timeoutMs)
    return reply.code(400).send({ error: `Test not supported for monitor type: ${type}` })
  })

  app.post<{ Params: { id: string } }>('/:id/check-now', async (req, reply) => {
    const rows = await db.select().from(monitors).where(eq(monitors.id, Number(req.params.id)))
    const monitor = rows[0]
    if (!monitor) return reply.code(404).send({ error: 'Not found' })
    await runCheck(monitor)
    const updated = (await db.select().from(monitors).where(eq(monitors.id, monitor.id)))[0]!
    return { ...updated, config: JSON.parse(updated.config) }
  })

  app.post<{ Params: { id: string } }>('/:id/reset-token', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(monitors).where(eq(monitors.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    if (existing.type !== 'webhook') return reply.code(400).send({ error: 'Only webhook monitors have tokens' })
    const now = Date.now()
    const results = await db.update(monitors)
      .set({ webhookToken: generateWebhookToken(), updatedAt: now })
      .where(eq(monitors.id, id))
      .returning()
    const result = results[0]!
    return { ...result, config: JSON.parse(result.config) }
  })

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>('/:id/history', async (req) => {
    const days = Number(req.query.days ?? 30)
    const since = Date.now() - days * 24 * 60 * 60 * 1000
    return db.select().from(monitorResults)
      .where(and(
        eq(monitorResults.monitorId, Number(req.params.id)),
        gte(monitorResults.checkedAt, since),
      ))
      .orderBy(desc(monitorResults.checkedAt))
      .limit(1000)
  })
}
