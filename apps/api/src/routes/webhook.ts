import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { and, count, eq, gte } from 'drizzle-orm'
import { tokenAllows } from '@better-forge/contracts'
import { ENTITY_KEY_ERROR } from '@better-forge/config-as-code'
import { db } from '../db/client.js'
import { monitors } from '../db/schema.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { applyDependencies, recordObservation } from '../workers/scheduler.js'
import { generateWebhookToken, INTERVAL_SECS_RANGE, WEBHOOK_TOKEN_PATTERN } from '../services/monitorInput.js'
import { normalizeHeartbeatKey } from '../services/heartbeatKey.js'
import { HEARTBEAT_KEY_RATE_LIMIT, WEBHOOK_RATE_LIMIT } from '../config/rateLimits.js'
import { getHeartbeatAutoCreateLimit } from '../config/heartbeat.js'
import { auditActor, snapshot, writeAudit } from '../kit/audit.js'
import { requestIdentity, requireAuth } from '../kit/authMiddleware.js'

const HEARTBEAT_STATUSES = ['up', 'down', 'degraded'] as const
type HeartbeatStatus = (typeof HEARTBEAT_STATUSES)[number]
const MAX_MESSAGE_LENGTH = 500
/** What a monitor made by a first heartbeat gets unless the request names an interval; both are changed in the admin like any other. */
const AUTO_CREATED_INTERVAL_SECS = 86_400
const MAX_NAME_LENGTH = 200
/** The limit on creating monitors counts the ones a token made within this time. */
const AUTO_CREATE_WINDOW_MS = 60 * 60_000

type WebhookQuery = { status?: string | string[], msg?: string | string[], interval?: string | string[], name?: string | string[] }
type WebhookRequest = FastifyRequest<{ Params: { token: string }, Querystring: WebhookQuery }>

// Control, bidi and zero-width characters let a sender forge text in the admin and in alerts.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu

function cleanMessage(msg: string): string | null {
  const cleaned = Array.from(msg.replace(UNSAFE_CHARS, ' ').trim()).slice(0, MAX_MESSAGE_LENGTH).join('').trim()
  return cleaned || null
}

type Heartbeat = { status: HeartbeatStatus, error: string | null }

/** Reads `status` and `msg`; a bad request is answered here and gives null. */
function parseHeartbeat(req: { query: WebhookQuery }, reply: FastifyReply): Heartbeat | null {
  // An empty status counts as absent, so `?status=` stays a plain heartbeat.
  const { status: rawStatus, msg } = req.query
  if (Array.isArray(rawStatus) || Array.isArray(msg)) {
    reply.code(400).send({ error: 'status and msg can be given only once' })
    return null
  }
  const status = (rawStatus || 'up') as HeartbeatStatus
  if (!HEARTBEAT_STATUSES.includes(status)) {
    reply.code(400).send({ error: `status must be one of: ${HEARTBEAT_STATUSES.join(', ')}` })
    return null
  }
  // The message is the check error, so it is only kept for a failing heartbeat.
  return { status, error: status !== 'up' && msg ? cleanMessage(msg) : null }
}

async function deliverHeartbeat(row: typeof monitors.$inferSelect, heartbeat: Heartbeat) {
  // A heartbeat counts as one check, so failure and recovery thresholds and maintenance windows
  // apply here exactly as they do to scheduled checks. Heartbeats can be frequent, so only a
  // status change is broadcast.
  // A failing heartbeat of a monitor whose dependency is down is 'affected', as for scheduled checks.
  const result = { status: heartbeat.status, responseMs: null, error: heartbeat.error }
  await recordObservation(row, heartbeat.status === 'up' ? result : await applyDependencies(row, result), { broadcast: 'on-change' })
}

async function handleWebhook(req: WebhookRequest, reply: FastifyReply) {
  const { token } = req.params
  if (!WEBHOOK_TOKEN_PATTERN.test(token)) return reply.code(404).send({ error: 'Not found' })
  const row = (await db.select().from(monitors).where(eq(monitors.webhookToken, token)))[0]
  if (!row) return reply.code(404).send({ error: 'Not found' })

  const heartbeat = parseHeartbeat(req, reply)
  if (!heartbeat) return reply
  await deliverHeartbeat(row, heartbeat)
  return reply.code(200).send({ ok: true })
}

type KeyedRequest = FastifyRequest<{ Params: { key: string }, Querystring: WebhookQuery }>
type KeyedOutcome = { row: typeof monitors.$inferSelect, created: boolean } | { limit: number }

type Creation = { name: string | null, intervalSecs: number }

/**
 * `name` and `interval` only matter to a heartbeat that creates the monitor, but they are checked on every one, so a wrong
 * value shows on the first request and not on whichever one happens to create. A bad request is answered here and gives null.
 */
function parseCreation(req: { query: WebhookQuery }, reply: FastifyReply): Creation | null {
  const { name, interval } = req.query
  if (Array.isArray(name) || Array.isArray(interval)) {
    reply.code(400).send({ error: 'name and interval can be given only once' })
    return null
  }
  let intervalSecs = AUTO_CREATED_INTERVAL_SECS
  if (interval) {
    const [min, max] = INTERVAL_SECS_RANGE
    intervalSecs = /^\d{1,9}$/.test(interval) ? Number(interval) : NaN
    if (!(intervalSecs >= min && intervalSecs <= max)) {
      reply.code(400).send({ error: `interval must be a whole number of seconds from ${min} to ${max}` })
      return null
    }
  }
  const cleaned = name ? Array.from(name.replace(UNSAFE_CHARS, ' ').trim()).slice(0, MAX_NAME_LENGTH).join('').trim() : ''
  return { name: cleaned || null, intervalSecs }
}

/**
 * The monitor holding `key`, or a new webhook monitor when none does and the token is still under its limit. Lookup, count
 * and insert share one transaction, so heartbeats racing for the same key create one monitor.
 */
async function findOrCreateByKey(key: string, tokenId: number, creation: Creation): Promise<KeyedOutcome> {
  const attempt = () => withImmediateTransaction(async (): Promise<KeyedOutcome> => {
    const existing = (await db.select().from(monitors).where(eq(monitors.key, key)))[0]
    if (existing) return { row: existing, created: false }
    const now = Date.now()
    const limit = getHeartbeatAutoCreateLimit()
    if (limit > 0) {
      const [{ made } = { made: 0 }] = await db.select({ made: count() }).from(monitors)
        .where(and(eq(monitors.autoCreatedByTokenId, tokenId), gte(monitors.createdAt, now - AUTO_CREATE_WINDOW_MS)))
      if (made >= limit) return { limit }
    }
    const [row] = await db.insert(monitors).values({
      key,
      name: creation.name ?? key,
      type: 'webhook',
      intervalSecs: creation.intervalSecs,
      config: '{}',
      currentStatus: 'pending',
      alertConfirmedStatus: 'pending',
      webhookToken: generateWebhookToken(),
      autoCreatedByTokenId: tokenId,
      createdAt: now,
      updatedAt: now,
    }).returning()
    return { row: row!, created: true }
  })
  try {
    return await attempt()
  } catch (error) {
    // A monitor with this key made outside the transaction queue (the admin API, a configuration import) in between.
    if (!(error instanceof Error) || !error.message.includes('UNIQUE constraint failed: monitors.key')) throw error
    return attempt()
  }
}

async function handleKeyedHeartbeat(req: KeyedRequest, reply: FastifyReply) {
  const identity = requestIdentity(req)
  if (!identity.apiToken || !tokenAllows(identity.apiToken.scopes, 'monitors:write')) {
    return reply.code(403).send({ error: 'This token does not have the "monitors:write" permission' })
  }
  const key = normalizeHeartbeatKey(req.params.key)
  if (!key) return reply.code(400).send({ error: ENTITY_KEY_ERROR })
  const heartbeat = parseHeartbeat(req, reply)
  if (!heartbeat) return reply

  const creation = parseCreation(req, reply)
  if (!creation) return reply

  const outcome = await findOrCreateByKey(key, identity.apiToken.id, creation)
  if ('limit' in outcome) {
    return reply.code(403).send({ error: `This token has already created ${outcome.limit} monitors in the last hour; try again later, raise HEARTBEAT_AUTO_CREATE_LIMIT or create the monitor by hand`, code: 'AUTO_CREATE_LIMIT' })
  }
  const { row, created } = outcome
  // A key of another kind of monitor must never receive a heartbeat: that would mark, say, an HTTPS monitor up.
  if (row.type !== 'webhook') return reply.code(409).send({ error: `Key "${key}" belongs to a monitor that is not a webhook monitor` })

  if (created) {
    writeAudit(auditActor(identity), 'create', 'monitor', row.id, row.name,
      snapshot({ name: row.name, type: row.type, intervalSecs: row.intervalSecs, source: 'heartbeat', tokenId: identity.apiToken.id }))
  }
  // After the transaction: recording an observation opens one of its own.
  await deliverHeartbeat(row, heartbeat)
  return reply.code(created ? 201 : 200).send(created ? { ok: true, created: true } : { ok: true })
}

export async function webhookRoutes(app: FastifyInstance) {
  const options = { config: { rateLimit: WEBHOOK_RATE_LIMIT } }
  app.get<{ Params: { token: string }, Querystring: WebhookQuery }>('/:token', options, handleWebhook)
  app.post<{ Params: { token: string }, Querystring: WebhookQuery }>('/:token', options, handleWebhook)

  // By key: authenticated with an API token, never with the session cookie. A GET carries no CSRF check, so a cookie
  // here would let any page an administrator visits create monitors. The request body is never read, so a sender whose
  // template adds a message to it (a log of a failed job) is not refused for its size or content type.
  await app.register(async (keyedApp) => {
    keyedApp.removeAllContentTypeParsers()
    keyedApp.addContentTypeParser('*', (_req, payload, done) => { payload.resume(); done(null) })
    const keyed = {
      config: { rateLimit: HEARTBEAT_KEY_RATE_LIMIT, allowApiToken: true, tokenScope: 'custom' },
      bodyLimit: 65_536,
      // A HEAD would run the GET handler, with its side effects.
      exposeHeadRoute: false,
      preHandler: [requireBearerToken, requireAuth],
    }
    keyedApp.get<{ Params: { key: string }, Querystring: WebhookQuery }>('/key/:key', keyed, handleKeyedHeartbeat)
    keyedApp.post<{ Params: { key: string }, Querystring: WebhookQuery }>('/key/:key', keyed, handleKeyedHeartbeat)
  })
}

async function requireBearerToken(req: FastifyRequest, reply: FastifyReply) {
  if (!/^Bearer bsp_/.test(req.headers.authorization ?? '')) {
    return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'Unauthorized' })
  }
}
