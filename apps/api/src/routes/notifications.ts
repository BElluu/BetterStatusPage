import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { monitors, notificationChannels, monitorNotificationChannels, smtpSettings, notificationDeliveries, notificationDeliveryAttempts } from '../db/schema.js'
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { retryNotificationDelivery, testNotificationChannel } from '../workers/notifier.js'
import { normalizeAlertPolicy, parseAlertPolicy } from '../services/alertPolicy.js'
import { auditActor, writeAudit, diffObjects, snapshot } from '../services/audit.js'
import { requestIdentity } from '../middleware/auth.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { parsePagination } from '../lib/pagination.js'
import { keyForNew, keyForUpdate, type KeyOwner } from '../lib/entityKey.js'
import type { NotificationChannelType } from '@bsp/shared'

const CHANNEL_TYPES: readonly NotificationChannelType[] = ['email', 'webhook', 'discord', 'teams', 'slack', 'telegram']

export async function notificationRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { page?: string; limit?: string; status?: string; channelId?: string; channelType?: string; monitorId?: string; eventType?: string; from?: string; to?: string }
  }>('/deliveries', async (req) => {
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 })
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
        suppressionReason: notificationDeliveries.suppressionReason, groupKey: notificationDeliveries.groupKey,
        createdAt: notificationDeliveries.createdAt, updatedAt: notificationDeliveries.updatedAt,
      }).from(notificationDeliveries).where(where).orderBy(desc(notificationDeliveries.createdAt)).limit(limit).offset(offset),
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
    const actor = requestIdentity(req)
    await writeAudit(auditActor(actor), 'update', 'notification_delivery', id, `${existing.channelName} · ${existing.monitorName}`, {
      manualRetry: { from: false, to: true },
    })
    return (await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id)))[0]
  })

  // ── Channels CRUD ──────────────────────────────────────────────────────────

  type ChannelRow = typeof notificationChannels.$inferSelect

  /** Only the last characters of a stored token ever leave the API, e.g. `••••••••MSGo`. */
  const maskToken = (token: string) => `${'•'.repeat(8)}${token.length >= 16 ? token.slice(-4) : ''}`

  /** Channels leave the API with both JSON columns expanded, the policy filled in with defaults and secrets masked. */
  function parseChannel(r: ChannelRow) {
    const config = JSON.parse(r.config)
    if (typeof config.botToken === 'string' && config.botToken) config.botToken = maskToken(config.botToken)
    return { ...r, config, alertPolicy: parseAlertPolicy(r.alertPolicy) }
  }

  /**
   * The form sends the masked token back when it was not edited: keep the stored one, but only while the
   * channel stays a Telegram one. The token can only ever be sent to api.telegram.org, so unlike SMTP a
   * changed chat ID needs no re-entry.
   */
  function keepUnchangedToken(config: unknown, existing: ChannelRow, effectiveType: string): unknown {
    if (existing.type !== 'telegram' || effectiveType !== 'telegram' || !config || typeof config !== 'object') return config
    const next = config as Record<string, unknown>
    const stored = (JSON.parse(existing.config) as { botToken?: unknown }).botToken
    if (typeof stored === 'string' && stored && next['botToken'] === maskToken(stored)) return { ...next, botToken: stored }
    return config
  }

  /** Flat, auditable view of the hygiene settings — nested JSON would produce useless diffs. */
  function policyAuditFields(r: ChannelRow): Record<string, unknown> {
    const p = parseAlertPolicy(r.alertPolicy)
    return {
      quietHours: p.quietHours.enabled ? `${p.quietHours.start}–${p.quietHours.end} ${p.quietHours.timezone} (${p.quietHours.mode})` : 'off',
      throttle: p.throttle.enabled ? `${p.throttle.maxAlerts} alerts / ${p.throttle.windowMinutes} min` : 'off',
      grouping: p.grouping.enabled ? `${p.grouping.minMonitors}+ monitors / ${p.grouping.windowSeconds} s` : 'off',
    }
  }

  /** Telegram needs a chat and a token, direct or from the vault; an edited mask is not a token. */
  function telegramConfigError(config: unknown): string | null {
    const c = (config && typeof config === 'object' ? config : {}) as { botToken?: unknown; vault?: { vaultId?: unknown; secretId?: unknown }; chatId?: unknown }
    if (typeof c.chatId !== 'string' || !c.chatId.trim()) return 'Telegram needs a Chat ID'
    if (c.vault) return Number.isInteger(c.vault.vaultId) && Number.isInteger(c.vault.secretId) && Number(c.vault.secretId) > 0 ? null : 'Pick a vault secret for the bot token'
    if (typeof c.botToken !== 'string' || !c.botToken.trim()) return 'Telegram needs a Bot Token'
    return c.botToken.includes('•') ? 'Paste the full bot token to replace the stored one' : null
  }

  app.get('/channels', async () => {
    const rows = await db.select().from(notificationChannels)
    return rows.map(parseChannel)
  })

  const channelKeyOwner: KeyOwner = async (key) =>
    (await db.select({ id: notificationChannels.id }).from(notificationChannels).where(eq(notificationChannels.key, key)))[0]?.id

  app.post<{ Body: {
    name: string; key?: string; type: string
    config: unknown; enabled?: number; notifyOnRecovery?: number; alertPolicy?: unknown
  } }>('/channels', async (req, reply) => {
    if (typeof req.body?.name !== 'string' || !req.body.name.trim()) return reply.code(400).send({ error: 'Name is required' })
    if (!CHANNEL_TYPES.includes(req.body.type as NotificationChannelType)) {
      return reply.code(400).send({ error: `Type must be one of: ${CHANNEL_TYPES.join(', ')}` })
    }
    if (req.body.type === 'telegram') {
      const problem = telegramConfigError(req.body.config)
      if (problem) return reply.code(400).send({ error: problem })
    }
    const resolvedKey = await keyForNew(req.body.name, req.body.key, channelKeyOwner)
    if ('error' in resolvedKey) return reply.code(resolvedKey.status).send({ error: resolvedKey.error })
    const now = Date.now()
    const results = await db.insert(notificationChannels).values({
      key: resolvedKey.key,
      name: req.body.name,
      type: req.body.type,
      config: JSON.stringify(req.body.config ?? {}),
      enabled: req.body.enabled ?? 1,
      notifyOnRecovery: req.body.notifyOnRecovery ?? 0,
      alertPolicy: JSON.stringify(normalizeAlertPolicy(req.body.alertPolicy)),
      createdAt: now,
      updatedAt: now,
    }).returning()
    const r = results[0]!
    const actor = requestIdentity(req)
    writeAudit(auditActor(actor), 'create', 'notification_channel', r.id, r.name,
      snapshot({ name: r.name, type: r.type, enabled: r.enabled, notifyOnRecovery: r.notifyOnRecovery, ...policyAuditFields(r) }))
    return parseChannel(r)
  })

  app.get<{ Params: { id: string } }>('/channels/:id', async (req, reply) => {
    const r = (await db.select().from(notificationChannels).where(eq(notificationChannels.id, Number(req.params.id))))[0]
    if (!r) return reply.code(404).send({ error: 'Not found' })
    return parseChannel(r)
  })

  app.patch<{ Params: { id: string }; Body: Partial<{
    name: string; key: string; type: string; config: unknown; enabled: number; notifyOnRecovery: number; alertPolicy: unknown
  }> }>('/channels/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(notificationChannels).where(eq(notificationChannels.id, id)))[0]
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const effectiveType = req.body.type ?? existing.type
    const config = req.body.config !== undefined ? keepUnchangedToken(req.body.config, existing, effectiveType) : undefined
    if (effectiveType === 'telegram' && (config !== undefined || req.body.type !== undefined)) {
      const problem = telegramConfigError(config ?? JSON.parse(existing.config))
      if (problem) return reply.code(400).send({ error: problem })
    }

    const updates: Partial<typeof notificationChannels.$inferInsert> = { updatedAt: Date.now() }
    if (req.body.key !== undefined) {
      const resolvedKey = await keyForUpdate(id, req.body.key, channelKeyOwner)
      if ('error' in resolvedKey) return reply.code(resolvedKey.status).send({ error: resolvedKey.error })
      updates.key = resolvedKey.key
    }
    if (req.body.name !== undefined)              updates.name = req.body.name
    if (req.body.type !== undefined)              updates.type = req.body.type
    if (req.body.config !== undefined)            updates.config = JSON.stringify(config)
    if (req.body.enabled !== undefined)           updates.enabled = req.body.enabled
    if (req.body.notifyOnRecovery !== undefined)  updates.notifyOnRecovery = req.body.notifyOnRecovery
    if (req.body.alertPolicy !== undefined)       updates.alertPolicy = JSON.stringify(normalizeAlertPolicy(req.body.alertPolicy))

    const results = await db.update(notificationChannels).set(updates).where(eq(notificationChannels.id, id)).returning()
    const r = results[0]!
    const actor = requestIdentity(req)
    const before = { name: existing.name, type: existing.type, enabled: existing.enabled, notifyOnRecovery: existing.notifyOnRecovery, ...policyAuditFields(existing) } as Record<string, unknown>
    const after  = { name: r.name, type: r.type, enabled: r.enabled, notifyOnRecovery: r.notifyOnRecovery, ...policyAuditFields(r) } as Record<string, unknown>
    const diff = diffObjects(before, after)
    if (req.body.config !== undefined) diff['config'] = { from: '[previous config]', to: '[updated config]' }
    if (Object.keys(diff).length) writeAudit(auditActor(actor), 'update', 'notification_channel', id, existing.name, diff)
    return parseChannel(r)
  })

  app.delete<{ Params: { id: string } }>('/channels/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db.select().from(notificationChannels).where(eq(notificationChannels.id, id)))[0]
    await db.delete(monitorNotificationChannels).where(eq(monitorNotificationChannels.channelId, id))
    await db.delete(notificationChannels).where(eq(notificationChannels.id, id))
    if (existing) {
      const actor = requestIdentity(req)
      writeAudit(auditActor(actor), 'delete', 'notification_channel', id, existing.name,
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

  app.put<{ Params: { monitorId: string }; Body: { channelIds: number[] } }>('/monitor/:monitorId/channels', async (req, reply) => {
    const monitorId = Number(req.params.monitorId)
    if (!Number.isSafeInteger(monitorId) || monitorId <= 0) return reply.code(400).send({ error: 'Invalid monitor id' })
    const monitor = (await db.select({ id: monitors.id }).from(monitors).where(eq(monitors.id, monitorId)))[0]
    if (!monitor) return reply.code(404).send({ error: 'Monitor not found' })
    const channelIds = req.body?.channelIds
    if (!Array.isArray(channelIds) || !channelIds.every((id) => Number.isSafeInteger(id) && id > 0)) {
      return reply.code(400).send({ error: 'channelIds must be an array of channel ids' })
    }
    const uniqueIds = [...new Set(channelIds)]
    if (uniqueIds.length > 0) {
      // The link table has no foreign key, so unknown ids would be stored silently.
      const known = await db.select({ id: notificationChannels.id }).from(notificationChannels).where(inArray(notificationChannels.id, uniqueIds))
      if (known.length !== uniqueIds.length) return reply.code(400).send({ error: 'Unknown notification channel' })
    }
    // Replace the links atomically so a failed insert never leaves the monitor without channels.
    await withImmediateTransaction(async () => {
      await db.delete(monitorNotificationChannels).where(eq(monitorNotificationChannels.monitorId, monitorId))
      if (uniqueIds.length > 0) {
        await db.insert(monitorNotificationChannels).values(uniqueIds.map((channelId) => ({ monitorId, channelId })))
      }
    })
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
  } }>('/smtp', async (req, reply) => {
    const now = Date.now()
    const existing = (await db.select().from(smtpSettings))[0]

    const passwordSupplied = !!req.body.password && req.body.password !== '••••••••'
    // Never forward the stored password to a different server or account: changing where it goes
    // requires re-entering it.
    if (existing?.password && !req.body.vault && !passwordSupplied && (
      req.body.host !== existing.host || Number(req.body.port) !== existing.port || (req.body.user ?? '') !== existing.user
    )) {
      return reply.code(400).send({ error: 'Re-enter the SMTP password when changing the host, port or username' })
    }

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
        : (passwordSupplied ? req.body.password! : existing.password)
      await db.update(smtpSettings).set({ ...values, password }).where(eq(smtpSettings.id, 1))
    } else {
      await db.insert(smtpSettings).values({ id: 1, ...values, password: req.body.vault ? '' : (req.body.password ?? '') })
    }

    const actor = requestIdentity(req)
    const diff: Record<string, unknown> = {}
    if (existing) {
      const before = { host: existing.host, port: existing.port, secure: existing.secure, user: existing.user, fromAddress: existing.fromAddress, fromName: existing.fromName } as Record<string, unknown>
      const after  = { host: req.body.host, port: req.body.port, secure: req.body.secure, user: req.body.user ?? '', fromAddress: req.body.fromAddress, fromName: req.body.fromName } as Record<string, unknown>
      Object.assign(diff, diffObjects(before, after))
    }
    if (req.body.password && req.body.password !== '••••••••') diff['password'] = { from: '[redacted]', to: '[redacted]' }
    writeAudit(auditActor(actor), existing ? 'update' : 'create', 'smtp_settings', 1, 'SMTP Settings', Object.keys(diff).length ? diff : undefined)
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
