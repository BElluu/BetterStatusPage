import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'crypto'
import { db } from '../db/client.js'
import { monitors, monitorResults, monitorDependencies } from '../db/schema.js'
import { eq, desc, gte, and, inArray } from 'drizzle-orm'
import { withImmediateTransaction } from '../db/transaction.js'
import { runCheck } from '../workers/scheduler.js'
import { validateDockerConfig } from '../workers/docker.js'
import { testHttps, testSqlServer, testPostgres, testMysql, testMongo, testPing, testDns, testDocker } from '../workers/testRunner.js'
import { auditActor, writeAudit, diffObjects, snapshot } from '../services/audit.js'
import { requestIdentity } from '../middleware/auth.js'
import { refreshPublishedMonitorIds } from '../services/publishedMonitors.js'
import { serveEventStream } from '../services/sse.service.js'
import { authenticateRequest } from '../services/authSession.js'
import type { HttpsConfig, DatabaseConfig, PingConfig, DnsConfig, DockerConfig, MonitorType } from '@bsp/shared'

const MONITOR_TYPES: readonly MonitorType[] = ['https', 'ping', 'dns', 'sqlserver', 'postgresql', 'mysql', 'mongodb', 'docker', 'webhook']
const MIN_TEST_TIMEOUT_MS = 500
const MAX_TEST_TIMEOUT_MS = 60_000

function configUrl(config: unknown): unknown {
  return config && typeof config === 'object' ? (config as { url?: unknown }).url : undefined
}

function generateWebhookToken(): string {
  return randomBytes(24).toString('hex')
}

/**
 * A monitor that (transitively) depends on itself would keep the whole loop 'affected' forever.
 * Returns the first requested dependency from which `monitorId` is already reachable, or null.
 * The monitor's own current edges are ignored because the request replaces them.
 */
function findDependencyCycle(
  monitorId: number,
  dependsOnIds: readonly number[],
  edges: ReadonlyArray<{ dependentId: number; dependsOnId: number }>,
): number | null {
  const graph = new Map<number, number[]>()
  for (const edge of edges) {
    if (edge.dependentId === monitorId) continue
    const targets = graph.get(edge.dependentId)
    if (targets) targets.push(edge.dependsOnId)
    else graph.set(edge.dependentId, [edge.dependsOnId])
  }
  const visited = new Set<number>()
  for (const start of dependsOnIds) {
    const stack = [start]
    while (stack.length > 0) {
      const current = stack.pop()!
      if (current === monitorId) return start
      if (visited.has(current)) continue
      visited.add(current)
      stack.push(...(graph.get(current) ?? []))
    }
  }
  return null
}

export async function monitorRoutes(app: FastifyInstance) {
  function parseMonitor(m: typeof monitors.$inferSelect) {
    return { ...m, config: JSON.parse(m.config), tags: JSON.parse(m.tags ?? '[]') }
  }

  app.get('/', async () => {
    const rows = await db.select().from(monitors)
    return rows.map(parseMonitor)
  })

  // Live status of every monitor, internal ones included; the public stream only carries published ones.
  // Signing out, a role change or a deleted account ends the stream right away (the session is
  // revoked); the keep-alive also re-checks the session so an expired one cannot keep listening.
  app.get('/events', async (req, reply) => {
    const { sessionId, userId } = requestIdentity(req)
    await serveEventStream(req, reply, {
      session: { sessionId, userId },
      stillAllowed: async () => {
        const identity = await authenticateRequest(req)
        return identity.role === 'admin' || identity.role === 'operator'
      },
    })
  })

  /** Thresholds are "consecutive checks", so anything below 1 is meaningless. */
  function clampThreshold(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback
    return Math.min(20, Math.max(1, Math.round(value)))
  }

  app.post<{ Body: {
    name: string; type: string
    intervalSecs?: number; timeoutMs?: number; retries?: number; config: unknown
    failureThreshold?: number; recoveryThreshold?: number
    tags?: Array<{ label: string; color: string }>
  } }>('/', async (req, reply) => {
    if (typeof req.body?.name !== 'string' || !req.body.name.trim()) return reply.code(400).send({ error: 'Name is required' })
    if (!MONITOR_TYPES.includes(req.body.type as MonitorType)) {
      return reply.code(400).send({ error: `Type must be one of: ${MONITOR_TYPES.join(', ')}` })
    }
    if (req.body.type === 'docker') {
      const invalid = validateDockerConfig(req.body.config)
      if (invalid) return reply.code(400).send({ error: invalid })
    }
    const now = Date.now()
    const results = await db.insert(monitors).values({
      name: req.body.name,
      type: req.body.type,
      intervalSecs: req.body.intervalSecs ?? 60,
      timeoutMs: req.body.timeoutMs ?? 10000,
      retries: req.body.retries ?? 1,
      failureThreshold: clampThreshold(req.body.failureThreshold, 1),
      recoveryThreshold: clampThreshold(req.body.recoveryThreshold, 1),
      config: JSON.stringify(req.body.config ?? {}),
      tags: JSON.stringify(req.body.tags ?? []),
      currentStatus: 'pending',
      alertConfirmedStatus: 'pending',
      webhookToken: req.body.type === 'webhook' ? generateWebhookToken() : null,
      createdAt: now,
      updatedAt: now,
    }).returning()
    const m = parseMonitor(results[0]!)
    const actor = requestIdentity(req)
    writeAudit(auditActor(actor), 'create', 'monitor', m.id, m.name,
      snapshot({
        name: m.name, type: m.type, intervalSecs: m.intervalSecs, timeoutMs: m.timeoutMs, retries: m.retries,
        failureThreshold: m.failureThreshold, recoveryThreshold: m.recoveryThreshold,
      }))
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
    failureThreshold: number; recoveryThreshold: number
    tags: Array<{ label: string; color: string }>
  }> }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(monitors).where(eq(monitors.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    if (req.body.type !== undefined && !MONITOR_TYPES.includes(req.body.type as MonitorType)) {
      return reply.code(400).send({ error: `Type must be one of: ${MONITOR_TYPES.join(', ')}` })
    }
    if ((req.body.type ?? existing.type) === 'docker' && req.body.config !== undefined) {
      const invalid = validateDockerConfig(req.body.config)
      if (invalid) return reply.code(400).send({ error: invalid })
    }

    const updates: Partial<typeof monitors.$inferInsert> = { updatedAt: Date.now() }
    if (req.body.name !== undefined) updates.name = req.body.name
    if (req.body.type !== undefined) updates.type = req.body.type
    if (req.body.intervalSecs !== undefined) updates.intervalSecs = req.body.intervalSecs
    if (req.body.timeoutMs !== undefined) updates.timeoutMs = req.body.timeoutMs
    if (req.body.retries !== undefined) updates.retries = req.body.retries
    if (req.body.failureThreshold !== undefined) updates.failureThreshold = clampThreshold(req.body.failureThreshold, existing.failureThreshold)
    if (req.body.recoveryThreshold !== undefined) updates.recoveryThreshold = clampThreshold(req.body.recoveryThreshold, existing.recoveryThreshold)
    if (req.body.config !== undefined) {
      updates.config = JSON.stringify(req.body.config)
      // Read the certificate again on the next check, so a changed warning setting takes effect
      // right away; a different endpoint also forgets what was known about the old certificate.
      updates.certCheckedAt = null
      if (configUrl(req.body.config) !== configUrl(JSON.parse(existing.config))) {
        updates.certExpiresAt = null
        updates.certWarnedDays = null
      }
    }
    if (req.body.tags !== undefined) updates.tags = JSON.stringify(req.body.tags)

    const results = await db.update(monitors).set(updates).where(eq(monitors.id, id)).returning()
    const m = parseMonitor(results[0]!)
    const actor = requestIdentity(req)
    const before = { name: existing.name, type: existing.type, intervalSecs: existing.intervalSecs, timeoutMs: existing.timeoutMs, retries: existing.retries, failureThreshold: existing.failureThreshold, recoveryThreshold: existing.recoveryThreshold, tags: existing.tags }
    const after  = { name: m.name, type: m.type, intervalSecs: m.intervalSecs, timeoutMs: m.timeoutMs, retries: m.retries, failureThreshold: m.failureThreshold, recoveryThreshold: m.recoveryThreshold, tags: JSON.stringify(m.tags) }
    const diff = diffObjects(before as Record<string, unknown>, after as Record<string, unknown>)
    if (req.body.config !== undefined) diff['config'] = { from: '[previous config]', to: '[updated config]' }
    if (Object.keys(diff).length) writeAudit(auditActor(actor), 'update', 'monitor', id, existing.name, diff)
    return m
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(monitors).where(eq(monitors.id, id)))[0]
    await db.delete(monitors).where(eq(monitors.id, id))
    if (existing) {
      await refreshPublishedMonitorIds()
      const actor = requestIdentity(req)
      writeAudit(auditActor(actor), 'delete', 'monitor', id, existing.name,
        snapshot({ name: existing.name, type: existing.type }))
    }
    return reply.code(204).send()
  })

  app.post<{ Body: { type: string; config: unknown; timeoutMs?: number } }>('/test', async (req, reply) => {
    const { type, config, timeoutMs: requestedTimeout } = req.body ?? {}
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return reply.code(400).send({ error: 'config must be an object' })
    }
    if (requestedTimeout !== undefined && !Number.isFinite(requestedTimeout)) {
      return reply.code(400).send({ error: 'timeoutMs must be a number' })
    }
    const timeoutMs = Math.min(MAX_TEST_TIMEOUT_MS, Math.max(MIN_TEST_TIMEOUT_MS, requestedTimeout ?? 10000))
    if (type === 'https') return testHttps(config as HttpsConfig, timeoutMs)
    if (type === 'sqlserver') return testSqlServer(config as DatabaseConfig, timeoutMs)
    if (type === 'postgresql') return testPostgres(config as DatabaseConfig, timeoutMs)
    if (type === 'mysql') return testMysql(config as DatabaseConfig, timeoutMs)
    if (type === 'mongodb') return testMongo(config as DatabaseConfig, timeoutMs)
    if (type === 'docker') return testDocker(config as DockerConfig, timeoutMs)
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

    const requested = req.body?.dependsOnIds ?? []
    if (!Array.isArray(requested)) return reply.code(400).send({ error: 'dependsOnIds must be an array of monitor ids' })
    const safeIds = [...new Set(requested.filter((depId) => Number.isInteger(depId) && depId !== id))]

    // Only IDs that actually reference existing monitors are kept.
    const validIds = safeIds.length > 0
      ? (await db.select({ id: monitors.id }).from(monitors).where(inArray(monitors.id, safeIds))).map((m) => m.id)
      : []
    const cycleVia = findDependencyCycle(id, validIds, await db.select().from(monitorDependencies))
    if (cycleVia !== null) {
      const via = (await db.select({ name: monitors.name }).from(monitors).where(eq(monitors.id, cycleVia)))[0]
      return reply.code(400).send({ error: `Dependency cycle: ${via?.name ?? `monitor ${cycleVia}`} already depends on this monitor` })
    }

    await withImmediateTransaction(async () => {
      await db.delete(monitorDependencies).where(eq(monitorDependencies.dependentId, id))
      if (validIds.length > 0) {
        await db.insert(monitorDependencies).values(validIds.map((depId) => ({ dependentId: id, dependsOnId: depId })))
      }
    })
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
