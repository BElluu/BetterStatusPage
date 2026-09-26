import type { FastifyInstance, FastifyReply } from 'fastify'
import { and, desc, eq, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { subscribers } from '../db/schema.js'
import type { AdminSubscriptionSettings, SubscriberList, SubscriptionPreferencesUpdate, SubscriptionRequest, SubscriptionSettings } from '@bsp/shared'
import { SUBSCRIBE_RATE_LIMIT, SUBSCRIPTION_TOKEN_RATE_LIMIT } from '../config/rateLimits.js'
import {
  SubscriptionError, confirmSubscription, getMethodStatuses, getPublicSubscriptionOptions, getSubscriptionPreferences,
  getSubscriptionSettings, normalizeSubscriptionSettings, requestSubscription, saveSubscriptionSettings, toSubscriber,
  unsubscribe, updateSubscriptionPreferences,
} from '../services/subscriptions.js'
import { isSmtpConfigured } from '../workers/notifier.js'
import { resolvePublicUrl } from '../config/publicUrl.js'
import { diffObjects, snapshot, writeAudit } from '../services/audit.js'

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof SubscriptionError) return reply.code(error.statusCode).send({ error: error.message })
  throw error
}

type TokenBody = { token?: string }

export async function publicSubscriptionRoutes(app: FastifyInstance) {
  // RFC 8058 one-click unsubscribe arrives as a form post from the mail provider.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)))
  })

  app.get('/options', async (_req, reply) => {
    // Operators expect a settings change to show up on the next page load.
    reply.header('Cache-Control', 'no-store')
    return getPublicSubscriptionOptions()
  })

  app.post<{ Body: SubscriptionRequest }>('/', {
    bodyLimit: 8 * 1024,
    config: { rateLimit: SUBSCRIBE_RATE_LIMIT },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as SubscriptionRequest
    // Bots fill every field; answer exactly like a real signup so they learn nothing.
    if (typeof body.website === 'string' && body.website.trim() !== '') return reply.code(202).send({ ok: true })
    try {
      await requestSubscription(body)
    } catch (error) {
      return sendError(reply, error)
    }
    return reply.code(202).send({ ok: true })
  })

  const tokenRoute = { bodyLimit: 8 * 1024, config: { rateLimit: SUBSCRIPTION_TOKEN_RATE_LIMIT } }

  app.post<{ Body: TokenBody }>('/confirm', tokenRoute, async (req, reply) => {
    try {
      return await confirmSubscription(String(req.body?.token ?? ''))
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post<{ Body: TokenBody }>('/preferences', tokenRoute, async (req, reply) => {
    try {
      return await getSubscriptionPreferences(String(req.body?.token ?? ''))
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.put<{ Body: TokenBody & SubscriptionPreferencesUpdate }>(
    '/preferences', tokenRoute, async (req, reply) => {
      try {
        const { token = '', ...changes } = req.body ?? {}
        return await updateSubscriptionPreferences(String(token), changes)
      } catch (error) {
        return sendError(reply, error)
      }
    },
  )

  app.post<{ Body: TokenBody; Querystring: TokenBody }>('/unsubscribe', tokenRoute, async (req, reply) => {
    try {
      await unsubscribe(String(req.body?.token ?? req.query.token ?? ''))
    } catch (error) {
      return sendError(reply, error)
    }
    return { ok: true }
  })
}

export async function adminSubscriberRoutes(app: FastifyInstance) {
  async function adminSettings(settings?: SubscriptionSettings): Promise<AdminSubscriptionSettings> {
    const current = settings ?? await getSubscriptionSettings()
    return {
      ...current,
      smtpConfigured: await isSmtpConfigured(),
      publicUrl: resolvePublicUrl(),
      methods: await getMethodStatuses(current),
    }
  }

  function auditFields(settings: SubscriptionSettings): Record<string, unknown> {
    return {
      enabled: settings.enabled,
      allowEmail: settings.allowEmail,
      allowWebhook: settings.allowWebhook,
      allowedEvents: settings.allowedEvents.join(', ') || 'none',
      allowComponentScope: settings.allowComponentScope,
      rssEnabled: settings.rssEnabled,
      allowSlack: settings.allowSlack,
      apiEnabled: settings.apiEnabled,
    }
  }

  app.get('/settings', async () => adminSettings())

  app.put<{ Body: Partial<SubscriptionSettings> }>('/settings', async (req, reply) => {
    const before = await getSubscriptionSettings()
    let values
    try {
      values = normalizeSubscriptionSettings(req.body ?? {}, before)
    } catch (error) {
      return sendError(reply, error)
    }
    const after = await saveSubscriptionSettings(values)
    const actor = req.user as { userId: number; email: string }
    const diff = diffObjects(auditFields(before), auditFields(after))
    if (Object.keys(diff).length) {
      writeAudit({ userId: actor.userId, userEmail: actor.email }, before.updatedAt ? 'update' : 'create',
        'subscription_settings', 1, 'Subscription settings', diff)
    }
    return adminSettings(after)
  })

  app.get<{ Querystring: { page?: string; limit?: string; status?: string; search?: string } }>('/', async (req): Promise<SubscriberList> => {
    const page = Math.max(1, Number(req.query.page ?? 1) || 1)
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 25) || 25))
    const conditions = []
    if (req.query.status) conditions.push(eq(subscribers.status, req.query.status))
    if (req.query.search) {
      const pattern = `%${req.query.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
      conditions.push(or(
        sql`${subscribers.email} LIKE ${pattern} ESCAPE '\\'`,
        sql`${subscribers.webhookUrl} LIKE ${pattern} ESCAPE '\\'`,
      ))
    }
    const where = conditions.length ? and(...conditions) : undefined
    const [rows, count, byStatus] = await Promise.all([
      db.select().from(subscribers).where(where).orderBy(desc(subscribers.createdAt)).limit(limit).offset((page - 1) * limit),
      db.select({ count: sql<number>`count(*)` }).from(subscribers).where(where),
      db.select({ status: subscribers.status, count: sql<number>`count(*)` }).from(subscribers).groupBy(subscribers.status),
    ])
    const stat = (status: string) => byStatus.find((row) => row.status === status)?.count ?? 0
    const total = count[0]?.count ?? 0
    return {
      subscribers: rows.map(toSubscriber),
      stats: {
        total: byStatus.reduce((sum, row) => sum + row.count, 0),
        active: stat('active'),
        pending: stat('pending'),
        unsubscribed: stat('unsubscribed'),
        disabled: stat('disabled'),
      },
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    }
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(subscribers).where(eq(subscribers.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    await db.delete(subscribers).where(eq(subscribers.id, id))
    const actor = req.user as { userId: number; email: string }
    writeAudit({ userId: actor.userId, userEmail: actor.email }, 'delete', 'subscriber', id, existing.email,
      snapshot({ type: existing.type, status: existing.status, webhookUrl: existing.webhookUrl }))
    return reply.code(204).send()
  })
}
