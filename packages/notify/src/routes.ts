import type { FastifyInstance, FastifyRequest } from 'fastify'
import { and, desc, eq, gte, lte, ne, sql } from 'drizzle-orm'
import { parsePagination, type Audit } from '@better-forge/audit'
import { tokenAllows, VAULT_USE_SCOPE, type NotificationChannelType } from '@better-forge/contracts'
import type { SqliteDatabase } from '@better-forge/db'
import { canonical, type RestoreResult } from '@better-forge/vault'
import { createAlertPolicy } from './alertPolicy.js'
import { CHANNEL_TYPES, channelConfigError } from './channelInput.js'
import type { NotifyTables } from './tables.js'

/** Result of choosing a key for a new channel: the key, or the HTTP status and message that refuse it. */
export type KeyResult = { key: string } | { status: 400 | 409; error: string }

export interface NotifyRoutesOptions {
  db: SqliteDatabase
  tables: NotifyTables
  audit: Audit
  /** The signed-in caller of a request (the routes sit behind the application's own guards). */
  identity: (req: FastifyRequest) => { userId: number; email: string; apiToken?: { scopes: readonly string[] } }

  /** Stored name of the grouping threshold in a channel's alert policy; it is also the name the API uses. */
  minSourcesKey: string
  /** What the application calls the things notifications are about, as the API shows it. */
  wire: {
    /** Field and query parameter that carry the id of the thing a delivery is about. */
    sourceId: string
    /** Field that carries its name. */
    sourceName: string
    /** Plural, as written in the audit text of a grouping rule. */
    sourcePlural: string
  }
  /** Sender name the SMTP settings show before they are saved. */
  defaultFromName: string

  /** The event types whose history this caller may not read (they are left out of the list and answer 404). */
  hiddenEventTypes: (req: FastifyRequest) => readonly string[]
  /** The secrets of a channel's configuration: masked on the way out, restored when a mask comes back. */
  secrets: {
    mask: (config: unknown) => unknown
    restore: (incoming: unknown, stored: unknown) => RestoreResult
  }
  /** Keeps a token that may not use vault secrets away from channels that reference one. */
  vaultUse: {
    refused: string
    problem: (token: { scopes: readonly string[] } | undefined, incoming: unknown, stored: unknown) => string | null
  }
  /** Chooses the key of a new channel (the requested one if it is free, else one made from the name). */
  resolveKey: (name: string, requested: unknown, ownerOf: (key: string) => Promise<number | undefined>) => Promise<KeyResult>

  /** Called before a channel is deleted, to remove whatever links the application keeps to it. */
  onChannelDeleted: (channelId: number) => Promise<void>
  /** Retries a failed delivery. */
  retryDelivery: (deliveryId: number) => Promise<boolean>
  /** Sends a test notification through a channel. */
  testChannel: (channelId: number) => Promise<{ ok: boolean; error?: string }>
  /** Sends a test mail through the SMTP settings. */
  testSmtp: (to: string) => Promise<{ ok: boolean; error?: string }>
}

const SMTP_PASSWORD_MASK = '••••••••'

const isConfigObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * The admin routes of the notifications: delivery history and retry, channel management and SMTP settings. A plain
 * plugin, so the hooks of the scope it is registered in apply to it.
 */
export function createNotifyRoutes(options: NotifyRoutesOptions) {
  const { db, audit, wire, identity, secrets, vaultUse } = options
  const { notificationChannels, notificationDeliveries, notificationDeliveryAttempts, smtpSettings } = options.tables
  const policy = createAlertPolicy({ minSourcesKey: options.minSourcesKey })
  const parseAlertPolicy = (stored: string) => policy.toWire(policy.parseAlertPolicy(stored)) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const normalizeAlertPolicy = (input: unknown) => policy.toWire(policy.normalizeAlertPolicy(input))

  type ChannelRow = typeof notificationChannels.$inferSelect

  /** A delivery as the API shows it: what it is about under the application's names, every other key where it was. */
  function wireDelivery<T extends object>(row: T): Record<string, unknown> {
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key === 'sourceId' ? wire.sourceId : key === 'sourceName' ? wire.sourceName : key, value,
    ]))
  }

  /**
   * Channels leave the API with both JSON columns expanded, the policy filled in with defaults and secrets masked.
   * The form sends a mask back when the secret was not edited, and the stored value is kept, as long as the channel
   * keeps its type.
   */
  function parseChannel(r: ChannelRow) {
    return { ...r, config: secrets.mask(JSON.parse(r.config)), alertPolicy: parseAlertPolicy(r.alertPolicy) }
  }

  /** Flat, auditable view of the hygiene settings - nested JSON would produce useless diffs. */
  function policyAuditFields(r: ChannelRow): Record<string, unknown> {
    const p = parseAlertPolicy(r.alertPolicy)
    return {
      quietHours: p.quietHours.enabled ? `${p.quietHours.start}–${p.quietHours.end} ${p.quietHours.timezone} (${p.quietHours.mode})` : 'off',
      throttle: p.throttle.enabled ? `${p.throttle.maxAlerts} alerts / ${p.throttle.windowMinutes} min` : 'off',
      grouping: p.grouping.enabled ? `${p.grouping[options.minSourcesKey]}+ ${wire.sourcePlural} / ${p.grouping.windowSeconds} s` : 'off',
    }
  }

  const channelKeyOwner = async (key: string) =>
    (await db.select({ id: notificationChannels.id }).from(notificationChannels).where(eq(notificationChannels.key, key)))[0]?.id

  return async function notifyRoutes(app: FastifyInstance) {
    const actor = (req: FastifyRequest) => audit.actor(identity(req))

    app.get<{ Querystring: Record<string, string | undefined> }>('/deliveries', async (req) => {
      const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 })
      const query = req.query
      const conditions = []
      if (query['status']) conditions.push(eq(notificationDeliveries.status, query['status']))
      if (query['channelId']) conditions.push(eq(notificationDeliveries.channelId, Number(query['channelId'])))
      if (query['channelType']) conditions.push(eq(notificationDeliveries.channelType, query['channelType']))
      if (query[wire.sourceId]) conditions.push(eq(notificationDeliveries.sourceId, Number(query[wire.sourceId])))
      if (query['eventType']) conditions.push(eq(notificationDeliveries.eventType, query['eventType']))
      if (query['from']) conditions.push(gte(notificationDeliveries.createdAt, Number(query['from'])))
      if (query['to']) conditions.push(lte(notificationDeliveries.createdAt, Number(query['to'])))
      for (const eventType of options.hiddenEventTypes(req)) conditions.push(ne(notificationDeliveries.eventType, eventType))
      const where = conditions.length ? and(...conditions) : undefined
      const [rows, count] = await Promise.all([
        db.select({
          id: notificationDeliveries.id, channelId: notificationDeliveries.channelId,
          channelName: notificationDeliveries.channelName, channelType: notificationDeliveries.channelType,
          sourceId: notificationDeliveries.sourceId, sourceName: notificationDeliveries.sourceName,
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
      return { deliveries: rows.map(wireDelivery), total, page, limit, pages: Math.ceil(total / limit) }
    })

    app.get<{ Params: { id: string } }>('/deliveries/:id', async (req, reply) => {
      const id = Number(req.params.id)
      const delivery = (await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id)))[0]
      if (!delivery || options.hiddenEventTypes(req).includes(delivery.eventType)) return reply.code(404).send({ error: 'Delivery not found' })
      const attempts = await db.select().from(notificationDeliveryAttempts)
        .where(eq(notificationDeliveryAttempts.deliveryId, id)).orderBy(desc(notificationDeliveryAttempts.attemptNumber))
      return { ...wireDelivery(delivery), variables: undefined, attempts }
    })

    app.post<{ Params: { id: string } }>('/deliveries/:id/retry', async (req, reply) => {
      const id = Number(req.params.id)
      const existing = (await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id)))[0]
      if (!existing || options.hiddenEventTypes(req).includes(existing.eventType)) return reply.code(404).send({ error: 'Delivery not found' })
      if (existing.status !== 'failed') return reply.code(409).send({ error: 'Only failed deliveries can be retried' })
      await options.retryDelivery(id)
      await audit.write(actor(req), 'update', 'notification_delivery', id, `${existing.channelName} · ${existing.sourceName}`, {
        manualRetry: { from: false, to: true },
      })
      const row = (await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id)))[0]
      // The row may be gone already (the retention purge); the answer is then empty, as it has always been.
      return row && wireDelivery(row)
    })

    // ── Channels CRUD ──────────────────────────────────────────────────────

    app.get('/channels', async () => {
      const rows = await db.select().from(notificationChannels)
      return rows.map(parseChannel)
    })

    app.post<{ Body: {
      name: string; key?: string; type: string
      config: unknown; enabled?: number; notifyOnRecovery?: number; alertPolicy?: unknown
    } }>('/channels', async (req, reply) => {
      if (typeof req.body?.name !== 'string' || !req.body.name.trim()) return reply.code(400).send({ error: 'Name is required' })
      if (!CHANNEL_TYPES.includes(req.body.type as NotificationChannelType)) {
        return reply.code(400).send({ error: `Type must be one of: ${CHANNEL_TYPES.join(', ')}` })
      }
      if (req.body.config !== undefined && req.body.config !== null && !isConfigObject(req.body.config)) {
        return reply.code(400).send({ error: 'config must be an object' })
      }
      const restored = secrets.restore(req.body.config ?? {}, undefined)
      if ('error' in restored) return reply.code(400).send({ error: restored.error })
      const vaultProblem = vaultUse.problem(identity(req).apiToken, restored.config, undefined)
      if (vaultProblem) return reply.code(403).send({ error: vaultProblem })
      const configProblem = channelConfigError(req.body.type, restored.config)
      if (configProblem) return reply.code(400).send({ error: configProblem })
      const resolvedKey = await options.resolveKey(req.body.name, req.body.key, channelKeyOwner)
      if ('error' in resolvedKey) return reply.code(resolvedKey.status).send({ error: resolvedKey.error })
      const now = Date.now()
      const results = await db.insert(notificationChannels).values({
        key: resolvedKey.key,
        name: req.body.name,
        type: req.body.type,
        config: JSON.stringify(restored.config),
        enabled: req.body.enabled ?? 1,
        notifyOnRecovery: req.body.notifyOnRecovery ?? 0,
        alertPolicy: JSON.stringify(normalizeAlertPolicy(req.body.alertPolicy)),
        createdAt: now,
        updatedAt: now,
      }).returning()
      const r = results[0]!
      audit.write(actor(req), 'create', 'notification_channel', r.id, r.name,
        audit.snapshot({ name: r.name, type: r.type, enabled: r.enabled, notifyOnRecovery: r.notifyOnRecovery, ...policyAuditFields(r) }))
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

      if (req.body.type !== undefined && !CHANNEL_TYPES.includes(req.body.type as NotificationChannelType)) {
        return reply.code(400).send({ error: `Type must be one of: ${CHANNEL_TYPES.join(', ')}` })
      }
      // The stored config belongs to the old type; keeping it under another one would also change what is masked.
      if (req.body.type !== undefined && req.body.type !== existing.type && req.body.config === undefined) {
        return reply.code(400).send({ error: 'Changing the type needs a new config in the same request' })
      }
      if (req.body.config !== undefined && !isConfigObject(req.body.config)) {
        return reply.code(400).send({ error: 'config must be an object' })
      }
      if (req.body.key !== undefined) return reply.code(400).send({ error: 'The key is set when the object is created and cannot be changed' })
      const effectiveType = req.body.type ?? existing.type
      let config: unknown
      if (req.body.config !== undefined) {
        const stored = effectiveType === existing.type ? JSON.parse(existing.config) : undefined
        const restored = secrets.restore(req.body.config, stored)
        if ('error' in restored) return reply.code(400).send({ error: restored.error })
        const vaultProblem = vaultUse.problem(identity(req).apiToken, restored.config, stored)
        if (vaultProblem) return reply.code(403).send({ error: vaultProblem })
        config = restored.config
      }
      if (config !== undefined || req.body.type !== undefined) {
        const configProblem = channelConfigError(effectiveType, config ?? JSON.parse(existing.config))
        if (configProblem) return reply.code(400).send({ error: configProblem })
      }

      const updates: Partial<typeof notificationChannels.$inferInsert> = { updatedAt: Date.now() }
      if (req.body.name !== undefined)              updates.name = req.body.name
      if (req.body.type !== undefined)              updates.type = req.body.type
      if (req.body.config !== undefined)            updates.config = JSON.stringify(config)
      if (req.body.enabled !== undefined)           updates.enabled = req.body.enabled
      if (req.body.notifyOnRecovery !== undefined)  updates.notifyOnRecovery = req.body.notifyOnRecovery
      if (req.body.alertPolicy !== undefined)       updates.alertPolicy = JSON.stringify(normalizeAlertPolicy(req.body.alertPolicy))

      const results = await db.update(notificationChannels).set(updates).where(eq(notificationChannels.id, id)).returning()
      const r = results[0]!
      const before = { name: existing.name, type: existing.type, enabled: existing.enabled, notifyOnRecovery: existing.notifyOnRecovery, ...policyAuditFields(existing) } as Record<string, unknown>
      const after = { name: r.name, type: r.type, enabled: r.enabled, notifyOnRecovery: r.notifyOnRecovery, ...policyAuditFields(r) } as Record<string, unknown>
      const diff = audit.diffObjects(before, after)
      if (req.body.config !== undefined) diff['config'] = { from: '[previous config]', to: '[updated config]' }
      if (Object.keys(diff).length) audit.write(actor(req), 'update', 'notification_channel', id, existing.name, diff)
      return parseChannel(r)
    })

    app.delete<{ Params: { id: string } }>('/channels/:id', async (req, reply) => {
      const id = Number(req.params.id)
      const existing = (await db.select().from(notificationChannels).where(eq(notificationChannels.id, id)))[0]
      await options.onChannelDeleted(id)
      await db.delete(notificationChannels).where(eq(notificationChannels.id, id))
      if (existing) {
        audit.write(actor(req), 'delete', 'notification_channel', id, existing.name,
          audit.snapshot({ name: existing.name, type: existing.type }))
      }
      return reply.code(204).send()
    })

    app.post<{ Params: { id: string } }>('/channels/:id/test', async (req, reply) => {
      const result = await options.testChannel(Number(req.params.id))
      if (!result.ok) return reply.code(422).send({ error: result.error })
      return { ok: true }
    })

    // ── SMTP Settings ──────────────────────────────────────────────────────

    app.get('/smtp', async () => {
      const row = (await db.select().from(smtpSettings))[0]
      if (!row) return { host: '', port: 587, secure: 0, user: '', password: '', fromAddress: '', fromName: options.defaultFromName, vault: null, updatedAt: 0 }
      return {
        ...row,
        password: row.password ? SMTP_PASSWORD_MASK : '',
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

      // A vault secret is sent to the SMTP server: a token without the permission to use vault secrets may keep the
      // reference and server that are saved, but not set or change them.
      const token = identity(req).apiToken
      if (token && req.body.vault && !tokenAllows(token.scopes, VAULT_USE_SCOPE)) {
        const saved = existing?.vaultConfig ?? null
        const sameReference = saved !== null && canonical(JSON.parse(saved)) === canonical(req.body.vault)
        const sameServer = !!existing && req.body.host === existing.host && Number(req.body.port) === existing.port
        const sameTransport = !!existing && Number(req.body.secure) === Number(existing.secure) && (req.body.user ?? '') === existing.user
        if (!sameReference || !sameServer || !sameTransport) return reply.code(403).send({ error: vaultUse.refused })
      }

      const passwordSupplied = !!req.body.password && req.body.password !== SMTP_PASSWORD_MASK
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

      const diff: Record<string, unknown> = {}
      if (existing) {
        const before = { host: existing.host, port: existing.port, secure: existing.secure, user: existing.user, fromAddress: existing.fromAddress, fromName: existing.fromName } as Record<string, unknown>
        const after = { host: req.body.host, port: req.body.port, secure: req.body.secure, user: req.body.user ?? '', fromAddress: req.body.fromAddress, fromName: req.body.fromName } as Record<string, unknown>
        Object.assign(diff, audit.diffObjects(before, after))
      }
      if (req.body.password && req.body.password !== SMTP_PASSWORD_MASK) diff['password'] = { from: '[redacted]', to: '[redacted]' }
      audit.write(actor(req), existing ? 'update' : 'create', 'smtp_settings', 1, 'SMTP Settings', Object.keys(diff).length ? diff : undefined)
      return { ok: true }
    })

    app.post<{ Body: { to: string } }>('/smtp/test', async (req, reply) => {
      const { to } = req.body
      if (!to) return reply.code(400).send({ error: 'Recipient address required' })
      const result = await options.testSmtp(to)
      if (!result.ok) return reply.code(422).send({ error: result.error })
      return { ok: true }
    })
  }
}
