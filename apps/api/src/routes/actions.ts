import type { FastifyInstance } from 'fastify'
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { actionFailureChannels, actionRuns, actions, monitorActions, monitors, notificationChannels } from '../db/schema.js'
import { cancelRunsOfAction, cancelUnlinkedRuns, retryActionRun, testAction } from '../workers/actionRunner.js'
import { auditActor, diffObjects, snapshot, writeAudit } from '../services/audit.js'
import { requestIdentity } from '../middleware/auth.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { parsePagination } from '../lib/pagination.js'
import { keyForNew, type KeyOwner } from '@better-kit/config-as-code'
import { maskSecrets, restoreSecrets } from '../services/secretFields.js'
import { actionConfigError, actionVaultProblem } from '../services/actionInput.js'
import { vaultUseProblem } from '../services/vaultUse.js'
import { ACTION_TRIGGER_STATUSES, type ActionTriggerStatus } from '@bsp/shared'
import { tokenAllows } from '@better-kit/contracts'

const MAX_MINUTES = 7 * 24 * 60

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

const MAX_NAME = 200
const isFlag = (value: unknown): value is 0 | 1 => value === 0 || value === 1

const isMinutes = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_MINUTES

export async function actionRoutes(app: FastifyInstance) {
  type ActionRow = typeof actions.$inferSelect

  /**
   * Like channels, actions leave the API with credential headers masked; sending the mask back keeps the stored value.
   * The channels told about a failed run come with them.
   */
  async function present(rows: ActionRow[]) {
    const links = rows.length === 0 ? [] : await db.select().from(actionFailureChannels).where(inArray(actionFailureChannels.actionId, rows.map((r) => r.id)))
    return rows.map((r) => ({
      ...r,
      config: maskSecrets('channel', JSON.parse(r.config)),
      failureChannelIds: links.filter((l) => l.actionId === r.id).map((l) => l.channelId).sort((a, b) => a - b),
    }))
  }

  /** The channel ids of a request, or what is wrong with them. A token must be allowed to manage channels to pick them. */
  async function parseFailureChannels(value: unknown, token: { scopes: readonly string[] } | undefined): Promise<{ ids: number[] } | { error: string; status: number }> {
    if (!Array.isArray(value) || !value.every((id) => Number.isSafeInteger(id) && id > 0)) return { error: 'failureChannelIds must be an array of channel ids', status: 400 }
    const ids = [...new Set(value as number[])].sort((a, b) => a - b)
    if (ids.length > 0) {
      const known = await db.select({ id: notificationChannels.id }).from(notificationChannels).where(inArray(notificationChannels.id, ids))
      if (known.length !== ids.length) return { error: 'Unknown notification channel', status: 400 }
    }
    if (token && !tokenAllows(token.scopes, 'channels:write')) return { error: 'This token does not have the "channels:write" permission, which it needs to choose notification channels', status: 403 }
    return { ids }
  }

  /** Replaces the list. Call it inside the transaction that saves the action, so the two never disagree. */
  async function setFailureChannels(actionId: number, ids: number[]) {
    await db.delete(actionFailureChannels).where(eq(actionFailureChannels.actionId, actionId))
    if (ids.length > 0) await db.insert(actionFailureChannels).values(ids.map((channelId) => ({ actionId, channelId })))
  }

  app.get('/', async () => present(await db.select().from(actions)))

  const keyOwner: KeyOwner = async (key) => (await db.select({ id: actions.id }).from(actions).where(eq(actions.key, key)))[0]?.id

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const r = (await db.select().from(actions).where(eq(actions.id, Number(req.params.id))))[0]
    if (!r) return reply.code(404).send({ error: 'Not found' })
    return (await present([r]))[0]
  })

  app.post<{ Body: { name: string; key?: string; config: unknown; enabled?: number; failureChannelIds?: unknown } }>('/', async (req, reply) => {
    if (typeof req.body?.name !== 'string' || !req.body.name.trim() || req.body.name.length > MAX_NAME) return reply.code(400).send({ error: `Name is required, up to ${MAX_NAME} characters` })
    if (req.body.enabled !== undefined && !isFlag(req.body.enabled)) return reply.code(400).send({ error: 'enabled must be 0 or 1' })
    if (!isObject(req.body.config)) return reply.code(400).send({ error: 'config must be an object' })
    const secrets = restoreSecrets('channel', req.body.config, undefined)
    if ('error' in secrets) return reply.code(400).send({ error: secrets.error })
    const problem = actionConfigError(secrets.config as Record<string, unknown>) ?? await actionVaultProblem(secrets.config as Record<string, unknown>)
    if (problem) return reply.code(400).send({ error: problem })
    const vaultProblem = vaultUseProblem(requestIdentity(req).apiToken, secrets.config, undefined)
    if (vaultProblem) return reply.code(403).send({ error: vaultProblem })
    let channelIds: number[] = []
    if (req.body.failureChannelIds !== undefined) {
      const parsed = await parseFailureChannels(req.body.failureChannelIds, requestIdentity(req).apiToken)
      if ('error' in parsed) return reply.code(parsed.status).send({ error: parsed.error })
      channelIds = parsed.ids
    }
    const resolvedKey = await keyForNew(req.body.name, req.body.key, keyOwner)
    if ('error' in resolvedKey) return reply.code(resolvedKey.status).send({ error: resolvedKey.error })
    const now = Date.now()
    const r = await withImmediateTransaction(async () => {
      const row = (await db.insert(actions).values({
        key: resolvedKey.key,
        name: req.body.name.trim(),
        config: JSON.stringify(secrets.config),
        enabled: req.body.enabled ?? 1,
        createdAt: now,
        updatedAt: now,
      }).returning())[0]!
      if (channelIds.length > 0) await setFailureChannels(row.id, channelIds)
      return row
    })
    writeAudit(auditActor(requestIdentity(req)), 'create', 'action', r.id, r.name,
      snapshot({ name: r.name, enabled: r.enabled, failureChannels: channelIds.length }))
    return (await present([r]))[0]
  })

  app.patch<{ Params: { id: string }; Body: Partial<{ name: string; key: string; config: unknown; enabled: number; failureChannelIds: unknown }> }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(actions).where(eq(actions.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    if (req.body.key !== undefined) return reply.code(400).send({ error: 'The key is set when the object is created and cannot be changed' })
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
      const problem = actionConfigError(secrets.config as Record<string, unknown>) ?? await actionVaultProblem(secrets.config as Record<string, unknown>)
      if (problem) return reply.code(400).send({ error: problem })
      const vaultProblem = vaultUseProblem(requestIdentity(req).apiToken, secrets.config, JSON.parse(existing.config))
      if (vaultProblem) return reply.code(403).send({ error: vaultProblem })
      updates.config = JSON.stringify(secrets.config)
    }
    const storedChannels = (await db.select().from(actionFailureChannels).where(eq(actionFailureChannels.actionId, id))).map((l) => l.channelId).sort((a, b) => a - b)
    let channelIds = storedChannels
    if (req.body.failureChannelIds !== undefined) {
      const parsed = await parseFailureChannels(req.body.failureChannelIds, requestIdentity(req).apiToken)
      if ('error' in parsed) return reply.code(parsed.status).send({ error: parsed.error })
      channelIds = parsed.ids
    }
    const r = await withImmediateTransaction(async () => {
      const row = (await db.update(actions).set(updates).where(eq(actions.id, id)).returning())[0]!
      if (channelIds.join() !== storedChannels.join()) await setFailureChannels(id, channelIds)
      return row
    })
    const diff = diffObjects({ name: existing.name, enabled: existing.enabled, failureChannels: storedChannels.length }, { name: r.name, enabled: r.enabled, failureChannels: channelIds.length })
    if (req.body.config !== undefined) diff['config'] = { from: '[previous config]', to: '[updated config]' }
    if (Object.keys(diff).length) writeAudit(auditActor(requestIdentity(req)), 'update', 'action', id, existing.name, diff)
    return (await present([r]))[0]
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(actions).where(eq(actions.id, id)))[0]
    if (existing) {
      await cancelRunsOfAction(id)
      await db.delete(monitorActions).where(eq(monitorActions.actionId, id))
      await db.delete(actionFailureChannels).where(eq(actionFailureChannels.actionId, id))
      await db.delete(actions).where(eq(actions.id, id))
      writeAudit(auditActor(requestIdentity(req)), 'delete', 'action', id, existing.name, snapshot({ name: existing.name }))
    }
    return reply.code(204).send()
  })

  /** Sends the real request once, so a Jenkins job or similar is started for real. */
  app.post<{ Params: { id: string } }>('/:id/test', async (req, reply) => {
    const result = await testAction(Number(req.params.id))
    if (!result.ok) return reply.code(422).send({ error: result.error, ...(result.status !== undefined ? { status: result.status } : {}), snippet: result.snippet })
    return { ok: true, status: result.status, snippet: result.snippet }
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

  app.post<{ Params: { id: string } }>('/runs/:id/retry', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(actionRuns).where(eq(actionRuns.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Run not found' })
    if (!(await retryActionRun(id))) return reply.code(409).send({ error: 'Only failed runs can be retried' })
    writeAudit(auditActor(requestIdentity(req)), 'update', 'action_run', id, `${existing.actionName} · ${existing.monitorName}`, {
      manualRetry: { from: false, to: true },
    })
    const { variables: _variables, ...run } = (await db.select().from(actionRuns).where(eq(actionRuns.id, id)))[0]!
    return run
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
