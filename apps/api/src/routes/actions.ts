import type { FastifyInstance } from 'fastify'
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { actionRuns, actions, monitorActions, monitors } from '../db/schema.js'
import { cancelRunsOfAction, cancelUnlinkedRuns, testAction } from '../workers/actionRunner.js'
import { auditActor, diffObjects, snapshot, writeAudit } from '../services/audit.js'
import { requestIdentity } from '../middleware/auth.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { parsePagination } from '../lib/pagination.js'
import { maskSecrets, restoreSecrets } from '../services/secretFields.js'
import { ACTION_TRIGGER_STATUSES, type ActionTriggerStatus } from '@bsp/shared'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH']
const MAX_MINUTES = 7 * 24 * 60

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** The first problem with an HTTP action configuration, or null. `{{variables}}` are filled in only when it runs. */
function configError(config: Record<string, unknown>): string | null {
  if (typeof config['url'] !== 'string' || !/^https?:\/\//i.test(config['url'])) return 'url must start with http:// or https://'
  if (typeof config['method'] !== 'string' || !METHODS.includes(config['method'])) return `method must be one of: ${METHODS.join(', ')}`
  if (config['body'] !== undefined && typeof config['body'] !== 'string') return 'body must be text'
  if (config['body'] && config['method'] === 'GET') return 'a GET request cannot have a body'
  if (typeof config['body'] === 'string' && config['body'].trim()) {
    // Variables sit inside string values ("{{status}}"), so a valid template is valid JSON as written.
    try { JSON.parse(config['body']) } catch { return 'body must be valid JSON, with {{variables}} inside string values' }
  }
  const headers = config['headers']
  if (headers !== undefined && (!isObject(headers) || !Object.values(headers).every((v) => typeof v === 'string'))) {
    return 'headers must be an object of text values'
  }
  return null
}

const MAX_NAME = 200
const isFlag = (value: unknown): value is 0 | 1 => value === 0 || value === 1

const isMinutes = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_MINUTES

export async function actionRoutes(app: FastifyInstance) {
  type ActionRow = typeof actions.$inferSelect

  /** Like channels, actions leave the API with credential headers masked; sending the mask back keeps the stored value. */
  const parseAction = (r: ActionRow) => ({ ...r, config: maskSecrets('channel', JSON.parse(r.config)) })

  app.get('/', async () => (await db.select().from(actions)).map(parseAction))

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const r = (await db.select().from(actions).where(eq(actions.id, Number(req.params.id))))[0]
    if (!r) return reply.code(404).send({ error: 'Not found' })
    return parseAction(r)
  })

  app.post<{ Body: { name: string; config: unknown; enabled?: number } }>('/', async (req, reply) => {
    if (typeof req.body?.name !== 'string' || !req.body.name.trim() || req.body.name.length > MAX_NAME) return reply.code(400).send({ error: `Name is required, up to ${MAX_NAME} characters` })
    if (req.body.enabled !== undefined && !isFlag(req.body.enabled)) return reply.code(400).send({ error: 'enabled must be 0 or 1' })
    if (!isObject(req.body.config)) return reply.code(400).send({ error: 'config must be an object' })
    const secrets = restoreSecrets('channel', req.body.config, undefined)
    if ('error' in secrets) return reply.code(400).send({ error: secrets.error })
    const problem = configError(secrets.config as Record<string, unknown>)
    if (problem) return reply.code(400).send({ error: problem })
    const now = Date.now()
    const r = (await db.insert(actions).values({
      name: req.body.name.trim(),
      config: JSON.stringify(secrets.config),
      enabled: req.body.enabled ?? 1,
      createdAt: now,
      updatedAt: now,
    }).returning())[0]!
    writeAudit(auditActor(requestIdentity(req)), 'create', 'action', r.id, r.name,
      snapshot({ name: r.name, enabled: r.enabled }))
    return parseAction(r)
  })

  app.patch<{ Params: { id: string }; Body: Partial<{ name: string; config: unknown; enabled: number }> }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(actions).where(eq(actions.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    if (req.body.name !== undefined && (typeof req.body.name !== 'string' || !req.body.name.trim() || req.body.name.length > MAX_NAME)) {
      return reply.code(400).send({ error: `Name is required, up to ${MAX_NAME} characters` })
    }
    if (req.body.enabled !== undefined && !isFlag(req.body.enabled)) return reply.code(400).send({ error: 'enabled must be 0 or 1' })
    const updates: Partial<typeof actions.$inferInsert> = { updatedAt: Date.now() }
    if (req.body.name !== undefined) updates.name = req.body.name.trim()
    if (req.body.enabled !== undefined) updates.enabled = req.body.enabled
    if (req.body.config !== undefined) {
      if (!isObject(req.body.config)) return reply.code(400).send({ error: 'config must be an object' })
      const secrets = restoreSecrets('channel', req.body.config, JSON.parse(existing.config))
      if ('error' in secrets) return reply.code(400).send({ error: secrets.error })
      const problem = configError(secrets.config as Record<string, unknown>)
      if (problem) return reply.code(400).send({ error: problem })
      updates.config = JSON.stringify(secrets.config)
    }
    const r = (await db.update(actions).set(updates).where(eq(actions.id, id)).returning())[0]!
    const diff = diffObjects({ name: existing.name, enabled: existing.enabled }, { name: r.name, enabled: r.enabled })
    if (req.body.config !== undefined) diff['config'] = { from: '[previous config]', to: '[updated config]' }
    if (Object.keys(diff).length) writeAudit(auditActor(requestIdentity(req)), 'update', 'action', id, existing.name, diff)
    return parseAction(r)
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(actions).where(eq(actions.id, id)))[0]
    if (existing) {
      await cancelRunsOfAction(id)
      await db.delete(monitorActions).where(eq(monitorActions.actionId, id))
      await db.delete(actions).where(eq(actions.id, id))
      writeAudit(auditActor(requestIdentity(req)), 'delete', 'action', id, existing.name, snapshot({ name: existing.name }))
    }
    return reply.code(204).send()
  })

  /** Sends the real request once, so a Jenkins job or similar is started for real. */
  app.post<{ Params: { id: string } }>('/:id/test', async (req, reply) => {
    const result = await testAction(Number(req.params.id))
    if (!result.ok) return reply.code(422).send({ error: result.error })
    return { ok: true }
  })

  // ── Run history ────────────────────────────────────────────────────────────

  app.get<{
    Querystring: { page?: string; limit?: string; status?: string; actionId?: string; monitorId?: string; from?: string; to?: string }
  }>('/runs', async (req) => {
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 })
    const conditions = []
    if (req.query.status) conditions.push(eq(actionRuns.status, req.query.status))
    if (req.query.actionId) conditions.push(eq(actionRuns.actionId, Number(req.query.actionId)))
    if (req.query.monitorId) conditions.push(eq(actionRuns.monitorId, Number(req.query.monitorId)))
    if (req.query.from) conditions.push(gte(actionRuns.createdAt, Number(req.query.from)))
    if (req.query.to) conditions.push(lte(actionRuns.createdAt, Number(req.query.to)))
    const where = conditions.length ? and(...conditions) : undefined
    const [runs, count] = await Promise.all([
      db.select({
        id: actionRuns.id, actionId: actionRuns.actionId, actionName: actionRuns.actionName,
        monitorId: actionRuns.monitorId, monitorName: actionRuns.monitorName, onStatus: actionRuns.onStatus,
        status: actionRuns.status, attemptCount: actionRuns.attemptCount, maxAttempts: actionRuns.maxAttempts,
        nextAttemptAt: actionRuns.nextAttemptAt, lastAttemptAt: actionRuns.lastAttemptAt,
        completedAt: actionRuns.completedAt, lastError: actionRuns.lastError,
        createdAt: actionRuns.createdAt, updatedAt: actionRuns.updatedAt,
      }).from(actionRuns).where(where).orderBy(desc(actionRuns.createdAt)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(actionRuns).where(where),
    ])
    const total = count[0]?.count ?? 0
    return { runs, total, page, limit, pages: Math.ceil(total / limit) }
  })

  // ── Monitor ↔ Action links ─────────────────────────────────────────────────

  app.get<{ Params: { monitorId: string } }>('/monitor/:monitorId', async (req) => {
    const links = await db.select().from(monitorActions).where(eq(monitorActions.monitorId, Number(req.params.monitorId)))
    return links.map(({ actionId, onStatus, delayMinutes, cooldownMinutes }) => ({ actionId, onStatus, delayMinutes, cooldownMinutes }))
  })

  app.put<{ Params: { monitorId: string }; Body: { actions: unknown } }>('/monitor/:monitorId', async (req, reply) => {
    const monitorId = Number(req.params.monitorId)
    if (!Number.isSafeInteger(monitorId) || monitorId <= 0) return reply.code(400).send({ error: 'Invalid monitor id' })
    const monitor = (await db.select({ id: monitors.id, name: monitors.name }).from(monitors).where(eq(monitors.id, monitorId)))[0]
    if (!monitor) return reply.code(404).send({ error: 'Monitor not found' })

    const incoming = req.body?.actions
    if (!Array.isArray(incoming)) return reply.code(400).send({ error: 'actions must be an array' })
    const links: { actionId: number; onStatus: ActionTriggerStatus; delayMinutes: number; cooldownMinutes: number }[] = []
    for (const item of incoming) {
      if (!isObject(item) || !Number.isSafeInteger(item['actionId']) || (item['actionId'] as number) <= 0) {
        return reply.code(400).send({ error: 'Each action needs an actionId' })
      }
      if (!ACTION_TRIGGER_STATUSES.includes(item['onStatus'] as ActionTriggerStatus)) {
        return reply.code(400).send({ error: `onStatus must be one of: ${ACTION_TRIGGER_STATUSES.join(', ')}` })
      }
      const delayMinutes = item['delayMinutes'] ?? 0
      const cooldownMinutes = item['cooldownMinutes'] ?? 0
      if (!isMinutes(delayMinutes) || !isMinutes(cooldownMinutes)) {
        return reply.code(400).send({ error: `delayMinutes and cooldownMinutes must be whole minutes from 0 to ${MAX_MINUTES}` })
      }
      links.push({ actionId: item['actionId'] as number, onStatus: item['onStatus'] as ActionTriggerStatus, delayMinutes, cooldownMinutes })
    }
    if (new Set(links.map((l) => `${l.actionId}:${l.onStatus}`)).size !== links.length) {
      return reply.code(400).send({ error: 'An action can be linked once per status' })
    }
    const actionIds = [...new Set(links.map((l) => l.actionId))]
    if (actionIds.length > 0) {
      const known = await db.select({ id: actions.id }).from(actions).where(inArray(actions.id, actionIds))
      if (known.length !== actionIds.length) return reply.code(400).send({ error: 'Unknown action' })
    }
    const key = (list: { actionId: number; onStatus: string; delayMinutes: number; cooldownMinutes: number }[]) =>
      JSON.stringify(list.map((l) => [l.actionId, l.onStatus, l.delayMinutes, l.cooldownMinutes]).sort())
    const before = await db.select().from(monitorActions).where(eq(monitorActions.monitorId, monitorId))
    await withImmediateTransaction(async () => {
      await db.delete(monitorActions).where(eq(monitorActions.monitorId, monitorId))
      if (links.length > 0) await db.insert(monitorActions).values(links.map((l) => ({ monitorId, ...l })))
    })
    await cancelUnlinkedRuns(monitorId, links)
    if (key(before) !== key(links)) {
      writeAudit(auditActor(requestIdentity(req)), 'update', 'monitor', monitorId, monitor.name, { actions: { from: `${before.length} linked`, to: `${links.length} linked` } })
    }
    return { ok: true }
  })
}
