import type { FastifyInstance, FastifyReply } from 'fastify'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { monitors, subscriberDeliveries, subscribers } from '../db/schema.js'
import type {
  AdminSubscriptionSettings, SubscriberDelivery, SubscriberDeliveryList, SubscriberEventType, SubscriberList,
  SubscriberType, SubscriptionPreferencesUpdate, SubscriptionRequest, SubscriptionSettings,
} from '@bsp/shared'
import { SUBSCRIBE_RATE_LIMIT, SUBSCRIPTION_TOKEN_RATE_LIMIT } from '../config/rateLimits.js'
import {
  SubscriptionError, confirmSubscription, getMethodStatuses, getPublicSubscriptionOptions, getSubscriptionPreferences,
  getSubscriptionSettings, normalizeSubscriptionSettings, requestSubscription, saveSubscriptionSettings, toSubscriber,
  unsubscribe, updateSubscriptionPreferences,
} from '../services/subscriptions.js'
import { isSmtpConfigured } from '../workers/notifier.js'
import { retrySubscriberDelivery, type SubscriberEvent } from '../workers/subscriberNotifier.js'
import { resolvePublicUrl } from '../config/publicUrl.js'
import { auditActor, diffObjects, snapshot, writeAudit } from '../services/audit.js'
import { requestIdentity } from '../middleware/auth.js'
import { parsePagination } from '../lib/pagination.js'
import { csvDocument } from '../lib/csv.js'
import { isStatusPagePrivate, protectStatusPage } from '../services/statusPageAccess.js'

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

  // Signing up needs a session while the page is private; the links in subscriber emails keep working without one.
  await app.register(async (signup) => {
    protectStatusPage(signup)

    signup.get('/options', async (_req, reply) => {
      // Operators expect a settings change to show up on the next page load.
      reply.header('Cache-Control', 'no-store')
      return getPublicSubscriptionOptions()
    })

    signup.post<{ Body: SubscriptionRequest }>('/', {
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
      statusPagePrivate: await isStatusPagePrivate(),
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
    const actor = requestIdentity(req)
    const diff = diffObjects(auditFields(before), auditFields(after))
    if (Object.keys(diff).length) {
      writeAudit(auditActor(actor), before.updatedAt ? 'update' : 'create',
        'subscription_settings', 1, 'Subscription settings', diff)
    }
    return adminSettings(after)
  })

  /** The status and search filters the list and the CSV export share. */
  function subscriberFilter(query: { status?: string; search?: string }) {
    const conditions = []
    if (query.status) conditions.push(eq(subscribers.status, query.status))
    if (query.search) {
      const pattern = `%${query.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
      conditions.push(or(
        sql`${subscribers.email} LIKE ${pattern} ESCAPE '\\'`,
        sql`${subscribers.webhookUrl} LIKE ${pattern} ESCAPE '\\'`,
      ))
    }
    return conditions.length ? and(...conditions) : undefined
  }

  app.get<{ Querystring: { page?: string; limit?: string; status?: string; search?: string } }>('/', async (req): Promise<SubscriberList> => {
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 })
    const where = subscriberFilter(req.query)
    const [rows, count, byStatus] = await Promise.all([
      db.select().from(subscribers).where(where).orderBy(desc(subscribers.createdAt)).limit(limit).offset(offset),
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

  app.get<{ Querystring: { status?: string; search?: string; ids?: string } }>('/export', async (req, reply) => {
    const ids = req.query.ids ? req.query.ids.split(',').map(Number).filter((id) => Number.isInteger(id) && id > 0) : null
    const where = ids ? inArray(subscribers.id, ids) : subscriberFilter(req.query)
    const [rows, monitorRows] = await Promise.all([
      db.select().from(subscribers).where(where).orderBy(desc(subscribers.createdAt)),
      db.select({ id: monitors.id, name: monitors.name }).from(monitors),
    ])
    const monitorName = (id: number) => monitorRows.find((monitor) => monitor.id === id)?.name ?? `#${id}`
    const lines = rows.map(toSubscriber).map((s) => [
      s.id, s.type, s.type === 'webhook' ? s.webhookUrl : s.email, s.email, s.status, s.events.join(' '),
      s.monitorIds.map(monitorName).join(' | '), s.tags.join(' '),
      s.lastNotifiedAt ? new Date(s.lastNotifiedAt).toISOString() : '', s.lastError ?? '',
    ])
    const header = ['id', 'type', 'destination', 'contact_email', 'status', 'events', 'monitors', 'tags', 'last_notified_at', 'last_error']
    // Addresses come from anonymous visitors, hence the formula neutralising in csvCell.
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="subscribers.csv"')
      .send(csvDocument(header, lines))
  })

  app.get<{
    Querystring: { page?: string; limit?: string; status?: string; eventType?: string; subscriberId?: string }
  }>('/deliveries', async (req): Promise<SubscriberDeliveryList> => {
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 })
    const conditions = []
    if (req.query.status) conditions.push(eq(subscriberDeliveries.status, req.query.status))
    if (req.query.eventType) conditions.push(eq(subscriberDeliveries.eventType, req.query.eventType))
    if (req.query.subscriberId) conditions.push(eq(subscriberDeliveries.subscriberId, Number(req.query.subscriberId)))
    const where = conditions.length ? and(...conditions) : undefined
    const [rows, count] = await Promise.all([
      db.select().from(subscriberDeliveries).where(where).orderBy(desc(subscriberDeliveries.createdAt)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(subscriberDeliveries).where(where),
    ])
    // Two queries rather than a join: the driver keys rows by column name, so the shared `id` and `status` would collide.
    const owners = rows.length
      ? await db.select().from(subscribers).where(inArray(subscribers.id, [...new Set(rows.map((row) => row.subscriberId))]))
      : []
    const total = count[0]?.count ?? 0
    return {
      deliveries: rows.flatMap((row) => {
        const owner = owners.find((subscriber) => subscriber.id === row.subscriberId)
        return owner ? [toDelivery(row, owner)] : []
      }),
      total, page, limit, pages: Math.ceil(total / limit),
    }
  })

  app.post<{ Params: { id: string } }>('/deliveries/:id/retry', async (req, reply) => {
    const id = Number(req.params.id)
    const delivery = (await db.select().from(subscriberDeliveries).where(eq(subscriberDeliveries.id, id)))[0]
    const owner = delivery && (await db.select().from(subscribers).where(eq(subscribers.id, delivery.subscriberId)))[0]
    if (!delivery || !owner) return reply.code(404).send({ error: 'Delivery not found' })
    if (!(await retrySubscriberDelivery(id))) return reply.code(409).send({ error: 'Only failed deliveries can be retried' })
    const actor = requestIdentity(req)
    await writeAudit(auditActor(actor), 'update', 'subscriber_delivery', id, toDelivery(delivery, owner).destination, {
      manualRetry: { from: false, to: true },
    })
    const after = (await db.select().from(subscriberDeliveries).where(eq(subscriberDeliveries.id, id)))[0]!
    return toDelivery(after, owner)
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(subscribers).where(eq(subscribers.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    await db.delete(subscribers).where(eq(subscribers.id, id))
    const actor = requestIdentity(req)
    writeAudit(auditActor(actor), 'delete', 'subscriber', id, existing.email,
      snapshot({ type: existing.type, status: existing.status, webhookUrl: existing.webhookUrl }))
    return reply.code(204).send()
  })
}

function toDelivery(delivery: typeof subscriberDeliveries.$inferSelect, subscriber: typeof subscribers.$inferSelect): SubscriberDelivery {
  let subject = ''
  try {
    const event = JSON.parse(delivery.event) as SubscriberEvent
    subject = event.incident?.title ?? event.maintenance?.name ?? ''
  } catch { /* an unreadable payload only costs the subject line */ }
  return {
    id: delivery.id,
    subscriberId: subscriber.id,
    subscriberType: subscriber.type as SubscriberType,
    destination: (subscriber.type === 'webhook' ? subscriber.webhookUrl : subscriber.email) ?? subscriber.email,
    eventType: delivery.eventType as SubscriberEventType,
    subject,
    status: delivery.status as SubscriberDelivery['status'],
    attemptCount: delivery.attemptCount,
    maxAttempts: delivery.maxAttempts,
    nextAttemptAt: delivery.nextAttemptAt,
    lastError: delivery.lastError,
    deliveredAt: delivery.deliveredAt,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  }
}
