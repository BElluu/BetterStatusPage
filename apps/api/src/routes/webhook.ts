import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { db } from '../db/client.js'
import { monitors } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { applyDependencies, recordObservation } from '../workers/scheduler.js'
import { WEBHOOK_TOKEN_PATTERN } from '../services/monitorInput.js'
import { WEBHOOK_RATE_LIMIT } from '../config/rateLimits.js'

const HEARTBEAT_STATUSES = ['up', 'down', 'degraded'] as const
type HeartbeatStatus = (typeof HEARTBEAT_STATUSES)[number]
const MAX_MESSAGE_LENGTH = 500

type WebhookQuery = { status?: string | string[], msg?: string | string[] }
type WebhookRequest = FastifyRequest<{ Params: { token: string }, Querystring: WebhookQuery }>

// Control, bidi and zero-width characters let a sender forge text in the admin and in alerts.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu

function cleanMessage(msg: string): string | null {
  const cleaned = Array.from(msg.replace(UNSAFE_CHARS, ' ').trim()).slice(0, MAX_MESSAGE_LENGTH).join('').trim()
  return cleaned || null
}

async function handleWebhook(req: WebhookRequest, reply: FastifyReply) {
  const { token } = req.params
  if (!WEBHOOK_TOKEN_PATTERN.test(token)) return reply.code(404).send({ error: 'Not found' })
  const row = (await db.select().from(monitors).where(eq(monitors.webhookToken, token)))[0]
  if (!row) return reply.code(404).send({ error: 'Not found' })

  // An empty status counts as absent, so `?status=` stays a plain heartbeat.
  const { status: rawStatus, msg } = req.query
  if (Array.isArray(rawStatus) || Array.isArray(msg)) {
    return reply.code(400).send({ error: 'status and msg can be given only once' })
  }
  const status = (rawStatus || 'up') as HeartbeatStatus
  if (!HEARTBEAT_STATUSES.includes(status)) {
    return reply.code(400).send({ error: `status must be one of: ${HEARTBEAT_STATUSES.join(', ')}` })
  }
  // The message is the check error, so it is only kept for a failing heartbeat.
  const error = status !== 'up' && msg ? cleanMessage(msg) : null

  // A heartbeat counts as one check, so failure and recovery thresholds and maintenance windows
  // apply here exactly as they do to scheduled checks. Heartbeats can be frequent, so only a
  // status change is broadcast.
  // A failing heartbeat of a monitor whose dependency is down is 'affected', as for scheduled checks.
  const result = { status, responseMs: null, error }
  await recordObservation(row, status === 'up' ? result : await applyDependencies(row, result), { broadcast: 'on-change' })

  return reply.code(200).send({ ok: true })
}

export async function webhookRoutes(app: FastifyInstance) {
  const options = { config: { rateLimit: WEBHOOK_RATE_LIMIT } }
  app.get<{ Params: { token: string }, Querystring: WebhookQuery }>('/:token', options, handleWebhook)
  app.post<{ Params: { token: string }, Querystring: WebhookQuery }>('/:token', options, handleWebhook)
}
