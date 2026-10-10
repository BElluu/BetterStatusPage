import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { monitors, monitorResults, monitorDependencies } from '../db/schema.js'
import { eq, desc, gte, and, inArray } from 'drizzle-orm'
import { withImmediateTransaction } from '../db/transaction.js'
import { runCheck } from '../workers/scheduler.js'
import { testHttps, testSqlServer, testPostgres, testMysql, testMongo, testPing, testDns, testDocker } from '../workers/testRunner.js'
import { auditActor, writeAudit, diffObjects, snapshot } from '../services/audit.js'
import { requestIdentity } from '../middleware/auth.js'
import { refreshPublishedMonitorIds } from '../services/publishedMonitors.js'
import { serveEventStream } from '../services/sse.service.js'
import { loadMonitorStats } from '../services/monitorStats.js'
import { getSchedulerConfig } from '../config/scheduler.js'
import { authenticateRequest } from '../services/authSession.js'
import { keyForNew, keyForUpdate, type KeyOwner } from '../lib/entityKey.js'
import { certResetsFor, generateWebhookToken, parseMonitorPatch, parseNewMonitor } from '../services/monitorInput.js'
import { maskSecrets, restoreSecrets } from '../services/secretFields.js'
import type { HttpsConfig, DatabaseConfig, PingConfig, DnsConfig, DockerConfig } from '@bsp/shared'

const MIN_TEST_TIMEOUT_MS = 500
const MAX_TEST_TIMEOUT_MS = 60_000

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
  /** Monitors leave the API with their secrets masked; see services/secretFields.ts. */
  function parseMonitor(m: typeof monitors.$inferSelect) {
    return { ...m, config: maskSecrets('monitor', JSON.parse(m.config)), tags: JSON.parse(m.tags ?? '[]') }
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
        const identity = await authenticateRequest(req, { allowApiToken: true })
        return identity.role === 'admin' || identity.role === 'operator'
      },
    })
  })

  const monitorKeyOwner: KeyOwner = async (key) =>
    (await db.select({ id: monitors.id }).from(monitors).where(eq(monitors.key, key)))[0]?.id

  app.post<{ Body: {
    name: string; key?: string; type: string
    intervalSecs?: number; timeoutMs?: number; retries?: number; config: unknown
    failureThreshold?: number; recoveryThreshold?: number
    tags?: Array<{ label: string; color: string }>
  } }>('/', async (req, reply) => {
    const parsed = parseNewMonitor(req.body)
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error })
    const fields = parsed.value
    const secrets = restoreSecrets('monitor', fields.config, undefined)
    if ('error' in secrets) return reply.code(400).send({ error: secrets.error })
    const resolvedKey = await keyForNew(fields.name, req.body.key, monitorKeyOwner)
    if ('error' in resolvedKey) return reply.code(resolvedKey.status).send({ error: resolvedKey.error })
    const now = Date.now()
    const results = await db.insert(monitors).values({
      key: resolvedKey.key,
      name: fields.name,
      type: fields.type,
      intervalSecs: fields.intervalSecs,
      timeoutMs: fields.timeoutMs,
      retries: fields.retries,
      failureThreshold: fields.failureThreshold,
      recoveryThreshold: fields.recoveryThreshold,
      config: JSON.stringify(secrets.config),
      tags: JSON.stringify(fields.tags),
      currentStatus: 'pending',
      alertConfirmedStatus: 'pending',
      webhookToken: fields.type === 'webhook' ? generateWebhookToken() : null,
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
    name: string; key: string; type: string
    intervalSecs: number; timeoutMs: number; retries: number; config: unknown
    failureThreshold: number; recoveryThreshold: number
    tags: Array<{ label: string; color: string }>
  }> }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(monitors).where(eq(monitors.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const parsed = parseMonitorPatch(req.body, existing)
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error })
    const patch = parsed.value

    const updates: Partial<typeof monitors.$inferInsert> = { updatedAt: Date.now() }
    if (req.body.key !== undefined) {
      const resolvedKey = await keyForUpdate(id, req.body.key, monitorKeyOwner)
      if ('error' in resolvedKey) return reply.code(resolvedKey.status).send({ error: resolvedKey.error })
      updates.key = resolvedKey.key
    }
    if (patch.name !== undefined) updates.name = patch.name
    if (patch.type !== undefined) updates.type = patch.type
    if (patch.intervalSecs !== undefined) updates.intervalSecs = patch.intervalSecs
    if (patch.timeoutMs !== undefined) updates.timeoutMs = patch.timeoutMs
    if (patch.retries !== undefined) updates.retries = patch.retries
    if (patch.failureThreshold !== undefined) updates.failureThreshold = patch.failureThreshold
    if (patch.recoveryThreshold !== undefined) updates.recoveryThreshold = patch.recoveryThreshold
    if (patch.config !== undefined) {
      // A masked secret means "keep the stored one", which only makes sense while the type stays the same.
      const type = patch.type ?? existing.type
      const secrets = restoreSecrets('monitor', patch.config, type === existing.type ? JSON.parse(existing.config) : undefined)
      if ('error' in secrets) return reply.code(400).send({ error: secrets.error })
      updates.config = JSON.stringify(secrets.config)
      Object.assign(updates, certResetsFor(JSON.parse(existing.config), secrets.config))
    }
    if (patch.tags !== undefined) updates.tags = JSON.stringify(patch.tags)

    const results = await db.update(monitors).set(updates).where(eq(monitors.id, id)).returning()
    const m = parseMonitor(results[0]!)
    const actor = requestIdentity(req)
    const before = { name: existing.name, type: existing.type, intervalSecs: existing.intervalSecs, timeoutMs: existing.timeoutMs, retries: existing.retries, failureThreshold: existing.failureThreshold, recoveryThreshold: existing.recoveryThreshold, tags: existing.tags }
    const after  = { name: m.name, type: m.type, intervalSecs: m.intervalSecs, timeoutMs: m.timeoutMs, retries: m.retries, failureThreshold: m.failureThreshold, recoveryThreshold: m.recoveryThreshold, tags: JSON.stringify(m.tags) }
    const diff = diffObjects(before as Record<string, unknown>, after as Record<string, unknown>)
    if (patch.config !== undefined) diff['config'] = { from: '[previous config]', to: '[updated config]' }
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

  // `monitorId` names the saved monitor being edited, so a masked secret in `config` is tested as the stored one.
  app.post<{ Body: { type: string; config: unknown; timeoutMs?: number; monitorId?: number } }>('/test', async (req, reply) => {
    const { type, config: submitted, timeoutMs: requestedTimeout, monitorId } = req.body ?? {}
    if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) {
      return reply.code(400).send({ error: 'config must be an object' })
    }
    const stored = monitorId === undefined ? undefined : (await db.select().from(monitors).where(eq(monitors.id, Number(monitorId))))[0]
    const secrets = restoreSecrets('monitor', submitted, stored?.type === type ? JSON.parse(stored.config) : undefined)
    if ('error' in secrets) return reply.code(400).send({ error: secrets.error })
    const config = secrets.config
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
    return parseMonitor(updated)
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
    return parseMonitor(result)
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

  app.get<{ Params: { id: string }; Querystring: { hours?: string } }>('/:id/stats', async (req, reply) => {
    const id = Number(req.params.id)
    const hours = req.query.hours === undefined ? 168 : Number(req.query.hours)
    if (!Number.isInteger(id) || id < 1 || !Number.isInteger(hours) || hours < 1) {
      return reply.code(400).send({ error: 'Invalid monitor id or hours' })
    }
    if (!(await db.select({ id: monitors.id }).from(monitors).where(eq(monitors.id, id)))[0]) {
      return reply.code(404).send({ error: 'Not found' })
    }
    const { resultRetentionDays } = getSchedulerConfig()
    reply.header('Cache-Control', 'no-store')
    return loadMonitorStats(id, Math.min(hours, resultRetentionDays * 24), resultRetentionDays)
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
