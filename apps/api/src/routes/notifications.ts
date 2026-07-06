import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { notificationChannels, monitorNotificationChannels, smtpSettings, notificationDeliveries, notificationDeliveryAttempts } from '../db/schema.js'
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { retryNotificationDelivery, testNotificationChannel } from '../workers/notifier.js'
import { writeAudit, diffObjects, snapshot } from '../services/audit.js'

export async function notificationRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { page?: string; limit?: string; status?: string; channelId?: string; channelType?: string; monitorId?: string; eventType?: string; from?: string; to?: string }
  }>('/deliveries', async (req) => {
    const page = Math.max(1, Number(req.query.page ?? 1))
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 25)))
    const conditions = []
    if (req.query.status) conditions.push(eq(notificationDeliveries.status, req.query.status))
    if (req.query.channelId) conditions.push(eq(notificationDeliveries.channelId, Number(req.query.channelId)))
    if (req.query.channelType) conditions.push(eq(notificationDeliveries.channelType, req.query.channelType))
    if (req.query.monitorId) conditions.push(eq(notificationDeliveries.monitorId, Number(req.query.monitorId)))
    if (req.query.eventType) conditions.push(eq(notificationDeliveries.eventType, req.query.eventType))
    if (req.query.from) conditions.push(gte(notificationDeliveries.createdAt, Number(req.query.from)))
    if (req.query.to) conditions.push(lte(notificationDeliveries.createdAt, Number(req.query.to)))
    const where = conditions.length ? and(...conditions) : undefined
    const [deliveries, count] = await Promise.all([
      db.select({
        id: notificationDeliveries.id, channelId: notificationDeliveries.channelId,
        channelName: notificationDeliveries.channelName, channelType: notificationDeliveries.channelType,
        monitorId: notificationDeliveries.monitorId, monitorName: notificationDeliveries.monitorName,
        eventType: notificationDeliveries.eventType, status: notificationDeliveries.status,
        targetStatus: notificationDeliveries.targetStatus, previousStatus: notificationDeliveries.previousStatus,
        attemptCount: notificationDeliveries.attemptCount, maxAttempts: notificationDeliveries.maxAttempts,
        nextAttemptAt: notificationDeliveries.nextAttemptAt, lastAttemptAt: notificationDeliveries.lastAttemptAt,
        deliveredAt: notificationDeliveries.deliveredAt, lastError: notificationDeliveries.lastError,
        createdAt: notificationDeliveries.createdAt, updatedAt: notificationDeliveries.updatedAt,
      }).from(notificationDeliveries).where(where).orderBy(desc(notificationDeliveries.createdAt)).limit(limit).offset((page - 1) * limit),
      db.select({ count: sql<number>`count(*)` }).from(notificationDeliveries).where(where),
    ])
    const total = count[0]?.count ?? 0
    return { deliveries, total, page, limit, pages: Math.ceil(total / limit) }
  })

  app.get<{ Params: { id: string } }>('/deliveries/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const delivery = (await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id)))[0]
    if (!delivery) return reply.code(404).send({ error: 'Delivery not found' })
    const attempts = await db.select().from(notificationDeliveryAttempts)
      .where(eq(notificationDeliveryAttempts.deliveryId, id)).orderBy(desc(notificationDeliveryAttempts.attemptNumber))
    return { ...delivery, variables: undefined, attempts }
  })

  app.post<{ Params: { id: string } }>('/deliveries/:id/retry', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Delivery not found' })
    if (existing.status !== 'failed') return reply.code(409).send({ error: 'Only failed deliveries can be retried' })
    await retryNotificationDelivery(id)
    const actor = req.user as { userId: number; email: string }
    await writeAudit({ userId: actor.userId, userEmail: actor.email }, 'update', 'notification_delivery', id, `${existing.channelName} · ${existing.monitorName}`, {
      manualRetry: { from: false, to: true },
    })
    return (await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id)))[0]
  })

  // ── Channels CRUD ──────────────────────────────────────────────────────────

  app.get('/channels', async () => {
    const rows = await db.select().from(notificationChannels)
    return rows.map((r) => ({ ...r, config: JSON.parse(r.config) }))
  })

  app.post<{ Body: {
    name: string; type: string
    config: unknown; enabled?: number; notifyOnRecovery?: number
  } }>('/channels', async (req) => {
    const now = Date.now()
    const results = await db.insert(notificationChannels).values({
      name: req.body.name,
      type: req.body.type,
      config: JSON.stringify(req.body.config ?? {}),
      enabled: req.body.enabled ?? 1,
      notifyOnRecovery: req.body.notifyOnRecovery ?? 0,
      createdAt: now,
      updatedAt: now,
    }).returning()
    const r = results[0]!
    const actor = req.user as { userId: number; email: string }
    writeAudit({ userId: actor.userId, userEmail: actor.email }, 'create', 'notification_channel', r.id, r.name,
      snapshot({ name: r.name, type: r.type, enabled: r.enabled, notifyOnRecovery: r.notifyOnRecovery }))
    return { ...r, config: JSON.parse(r.config) }
  })

  app.get<{ Params: { id: string } }>('/channels/:id', async (req, reply) => {
    const r = (await db.select().from(notificationChannels).where(eq(notificationChannels.id, Number(req.params.id))))[0]
    if (!r) return reply.code(404).send({ error: 'Not found' })
    return { ...r, config: JSON.parse(r.config) }
  })

  app.patch<{ Params: { id: string }; Body: Partial<{
    name: string; type: string; config: unknown; enabled: number; notifyOnRecovery: number
  }> }>('/channels/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(notificationChannels).where(eq(notificationChannels.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const updates: Partial<typeof notificationChannels.$inferInsert> = { updatedAt: Date.now() }
    if (req.body.name !== undefined)              updates.name = req.body.name
    if (req.body.type !== undefined)              updates.type = req.body.type
    if (req.body.config !== undefined)            updates.config = JSON.stringify(req.body.config)
    if (req.body.enabled !== undefined)           updates.enabled = req.body.enabled
    if (req.body.notifyOnRecovery !== undefined)  updates.notifyOnRecovery = req.body.notifyOnRecovery

    const results = await db.update(notificationChannels).set(updates).where(eq(notificationChannels.id, id)).returning()
    const r = results[0]!
    const actor = req.user as { userId: number; email: string }
    const before = { name: existing.name, type: existing.type, enabled: existing.enabled, notifyOnRecovery: existing.notifyOnRecovery } as Record<string, unknown>
    const after  = { name: r.name, type: r.type, enabled: r.enabled, notifyOnRecovery: r.notifyOnRecovery } as Record<string, unknown>
    const diff = diffObjects(before, after)
    if (req.body.config !== undefined) diff['config'] = { from: '[previous config]', to: '[updated config]' }
    if (Object.keys(diff).length) writeAudit({ userId: actor.userId, userEmail: actor.email }, 'update', 'notification_channel', id, existing.name, diff)
    return { ...r, config: JSON.parse(r.config) }
  })

  app.delete<{ Params: { id: string } }>('/channels/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(notificationChannels).where(eq(notificationChannels.id, id)))[0]
    await db.delete(monitorNotificationChannels).where(eq(monitorNotificationChannels.channelId, id))
    await db.delete(notificationChannels).where(eq(notificationChannels.id, id))
    if (existing) {
      const actor = req.user as { userId: number; email: string }
      writeAudit({ userId: actor.userId, userEmail: actor.email }, 'delete', 'notification_channel', id, existing.name,
        snapshot({ name: existing.name, type: existing.type }))
    }
    return reply.code(204).send()
  })

  app.post<{ Params: { id: string } }>('/channels/:id/test', async (req, reply) => {
    const result = await testNotificationChannel(Number(req.params.id))
    if (!result.ok) return reply.code(422).send({ error: result.error })
    return { ok: true }
  })

  // ── Monitor ↔ Channel links ────────────────────────────────────────────────

  app.get<{ Params: { monitorId: string } }>('/monitor/:monitorId/channels', async (req) => {
    const links = await db.select().from(monitorNotificationChannels)
      .where(eq(monitorNotificationChannels.monitorId, Number(req.params.monitorId)))
    return links.map((l) => l.channelId)
  })

  app.put<{ Params: { monitorId: string }; Body: { channelIds: number[] } }>('/monitor/:monitorId/channels', async (req) => {
    const monitorId = Number(req.params.monitorId)
    await db.delete(monitorNotificationChannels).where(eq(monitorNotificationChannels.monitorId, monitorId))
    if (req.body.channelIds.length > 0) {
      await db.insert(monitorNotificationChannels).values(
        req.body.channelIds.map((channelId) => ({ monitorId, channelId })),
      )
    }
    return { ok: true }
  })

  // ── SMTP Settings ──────────────────────────────────────────────────────────

  app.get('/smtp', async () => {
    const row = (await db.select().from(smtpSettings))[0]
    if (!row) return { host: '', port: 587, secure: 0, user: '', password: '', fromAddress: '', fromName: 'BSP Alerts', vault: null, updatedAt: 0 }
    return {
      ...row,
      password: row.password ? '••••••••' : '',
      vault: row.vaultConfig ? JSON.parse(row.vaultConfig) : null,
    }
  })

  app.put<{ Body: {
    host: string; port: number; secure: number
    user: string; password?: string; fromAddress: string; fromName: string
    vault?: { vaultId: number; secretId: number; fieldMapping?: Record<string, string> } | null
  } }>('/smtp', async (req) => {
    const now = Date.now()
    const existing = (await db.select().from(smtpSettings))[0]

    const values = {
      host: req.body.host,
      port: req.body.port,
      secure: req.body.secure,
      user: req.body.vault ? '' : (req.body.user ?? ''),
      fromAddress: req.body.fromAddress,
      fromName: req.body.fromName,
      vaultConfig: req.body.vault ? JSON.stringify(req.body.vault) : null,
      updatedAt: now,
    }

    if (existing) {
      const password = req.body.vault
        ? ''
        : (req.body.password && req.body.password !== '••••••••' ? req.body.password : existing.password)
      await db.update(smtpSettings).set({ ...values, password }).where(eq(smtpSettings.id, 1))
    } else {
      await db.insert(smtpSettings).values({ id: 1, ...values, password: req.body.vault ? '' : (req.body.password ?? '') })
    }

    const actor = req.user as { userId: number; email: string }
    const diff: Record<string, unknown> = {}
    if (existing) {
      const before = { host: existing.host, port: existing.port, secure: existing.secure, user: existing.user, fromAddress: existing.fromAddress, fromName: existing.fromName } as Record<string, unknown>
      const after  = { host: req.body.host, port: req.body.port, secure: req.body.secure, user: req.body.user ?? '', fromAddress: req.body.fromAddress, fromName: req.body.fromName } as Record<string, unknown>
      Object.assign(diff, diffObjects(before, after))
    }
    if (req.body.password && req.body.password !== '••••••••') diff['password'] = { from: '[redacted]', to: '[redacted]' }
    writeAudit({ userId: actor.userId, userEmail: actor.email }, existing ? 'update' : 'create', 'smtp_settings', 1, 'SMTP Settings', Object.keys(diff).length ? diff : undefined)
    return { ok: true }
  })

  app.post<{ Body: { to: string } }>('/smtp/test', async (req, reply) => {
    const { to } = req.body
    if (!to) return reply.code(400).send({ error: 'Recipient address required' })
    const { testSmtp } = await import('../workers/notifier.js')
    const result = await testSmtp(to)
    if (!result.ok) return reply.code(422).send({ error: result.error })
    return { ok: true }
  })
}
