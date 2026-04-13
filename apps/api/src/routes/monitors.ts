import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'crypto'
import { db } from '../db/client.js'
import { monitors, monitorResults, monitorDependencies } from '../db/schema.js'
import { eq, desc, gte, and, inArray } from 'drizzle-orm'
import { runCheck } from '../workers/scheduler.js'
import { testHttps, testSqlServer, testPing, testDns } from '../workers/testRunner.js'
import { writeAudit, diffObjects, snapshot } from '../services/audit.js'
import type { HttpsConfig, SqlServerConfig, PingConfig, DnsConfig } from '@bsp/shared'

function generateWebhookToken(): string {
  return randomBytes(24).toString('hex')
}

export async function monitorRoutes(app: FastifyInstance) {
  function parseMonitor(m: typeof monitors.$inferSelect) {
    return { ...m, config: JSON.parse(m.config), tags: JSON.parse(m.tags ?? '[]') }
  }

  app.get('/', async () => {
    const rows = await db.select().from(monitors)
    return rows.map(parseMonitor)
  })

  app.post<{ Body: {
    name: string; type: string
    intervalSecs?: number; timeoutMs?: number; retries?: number; config: unknown
    tags?: Array<{ label: string; color: string }>
  } }>('/', async (req) => {
    const now = Date.now()
    const results = await db.insert(monitors).values({
      name: req.body.name,
      type: req.body.type,
      intervalSecs: req.body.intervalSecs ?? 60,
      timeoutMs: req.body.timeoutMs ?? 10000,
      retries: req.body.retries ?? 1,
      config: JSON.stringify(req.body.config ?? {}),
      tags: JSON.stringify(req.body.tags ?? []),
      currentStatus: 'pending',
      webhookToken: req.body.type === 'webhook' ? generateWebhookToken() : null,
      createdAt: now,
      updatedAt: now,
    }).returning()
    const m = parseMonitor(results[0]!)
    const actor = req.user as { userId: number; email: string }
    writeAudit({ userId: actor.userId, userEmail: actor.email }, 'create', 'monitor', m.id, m.name,
      snapshot({ name: m.name, type: m.type, intervalSecs: m.intervalSecs, timeoutMs: m.timeoutMs, retries: m.retries }))
    return m
  })

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const monitor = (await db.select().from(monitors).where(eq(monitors.id, Number(req.params.id))))[0]
    if (!monitor) return reply.code(404).send({ error: 'Not found' })
    return parseMonitor(monitor)
  })

  app.patch<{ Params: { id: string }; Body: Partial<{
    name: string; type: string
    intervalSecs: number; timeoutMs: number; retries: number; config: unknown
    tags: Array<{ label: string; color: string }>
  }> }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(monitors).where(eq(monitors.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const updates: Partial<typeof monitors.$inferInsert> = { updatedAt: Date.now() }
    if (req.body.name !== undefined) updates.name = req.body.name
    if (req.body.type !== undefined) updates.type = req.body.type
    if (req.body.intervalSecs !== undefined) updates.intervalSecs = req.body.intervalSecs
    if (req.body.timeoutMs !== undefined) updates.timeoutMs = req.body.timeoutMs
    if (req.body.retries !== undefined) updates.retries = req.body.retries
    if (req.body.config !== undefined) updates.config = JSON.stringify(req.body.config)
    if (req.body.tags !== undefined) updates.tags = JSON.stringify(req.body.tags)

    const results = await db.update(monitors).set(updates).where(eq(monitors.id, id)).returning()
    const m = parseMonitor(results[0]!)
    const actor = req.user as { userId: number; email: string }
    const before = { name: existing.name, type: existing.type, intervalSecs: existing.intervalSecs, timeoutMs: existing.timeoutMs, retries: existing.retries, tags: existing.tags }
    const after  = { name: m.name, type: m.type, intervalSecs: m.intervalSecs, timeoutMs: m.timeoutMs, retries: m.retries, tags: JSON.stringify(m.tags) }
    const diff = diffObjects(before as Record<string, unknown>, after as Record<string, unknown>)
    if (req.body.config !== undefined) diff['config'] = { from: '[previous config]', to: '[updated config]' }
    if (Object.keys(diff).length) writeAudit({ userId: actor.userId, userEmail: actor.email }, 'update', 'monitor', id, existing.name, diff)
    return m
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(monitors).where(eq(monitors.id, id)))[0]
    await db.delete(monitors).where(eq(monitors.id, id))
    if (existing) {
      const actor = req.user as { userId: number; email: string }
      writeAudit({ userId: actor.userId, userEmail: actor.email }, 'delete', 'monitor', id, existing.name,
        snapshot({ name: existing.name, type: existing.type }))
    }
    return reply.code(204).send()
  })

  app.post<{ Body: { type: string; config: unknown; timeoutMs?: number } }>('/test', async (req, reply) => {
    const { type, config, timeoutMs = 10000 } = req.body
    if (type === 'https') return testHttps(config as HttpsConfig, timeoutMs)
    if (type === 'sqlserver') return testSqlServer(config as SqlServerConfig, timeoutMs)
    if (type === 'ping') return testPing(config as PingConfig, timeoutMs)
    if (type === 'dns') return testDns(config as DnsConfig, timeoutMs)
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

  app.get<{ Params: { id: string } }>('/:id/dependencies', async (req) => {
    const id = Number(req.params.id)
    const deps = await db.select().from(monitorDependencies).where(eq(monitorDependencies.dependentId, id))
    return { dependsOnIds: deps.map((d) => d.dependsOnId) }
  })

  app.put<{ Params: { id: string }; Body: { dependsOnIds: number[] } }>('/:id/dependencies', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(monitors).where(eq(monitors.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const safeIds = (req.body.dependsOnIds ?? []).filter((depId) => depId !== id)

    await db.delete(monitorDependencies).where(eq(monitorDependencies.dependentId, id))
    if (safeIds.length > 0) {
      // Only insert IDs that actually reference existing monitors
      const existingTargets = await db.select().from(monitors).where(inArray(monitors.id, safeIds))
      const validIds = existingTargets.map((m) => m.id)
      if (validIds.length > 0) {
        await db.insert(monitorDependencies).values(validIds.map((depId) => ({ dependentId: id, dependsOnId: depId })))
      }
    }
    return { ok: true }
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
