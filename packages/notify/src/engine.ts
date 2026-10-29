import { and, asc, desc, eq, gt, gte, inArray, isNotNull, like, lt, lte, ne, sql } from 'drizzle-orm'
import type { NotificationSuppressionReason, VaultRef } from '@better-forge/contracts'
import type { SqliteDatabase } from '@better-forge/db'
import { createAlertPolicy, isWithinQuietHours, quietHoursEndAt, type AlertPolicy } from './alertPolicy.js'
import type { NotifyTables } from './tables.js'
import { MAX_DELIVERY_ATTEMPTS, RETRY_DELAYS_MS } from './template.js'

export type ChannelRow = NotifyTables['notificationChannels']['$inferSelect']
export type DeliveryRow = NotifyTables['notificationDeliveries']['$inferSelect']

/** What a delivery is about. A delivery without a source (a test, a digest) has none. */
export interface DeliveryDetails {
  sourceId: number | null
  sourceName: string
  eventType: string
}

export interface NotifyEngineOptions {
  db: SqliteDatabase
  tables: NotifyTables
  /** Stored name of the grouping threshold in a channel's alert policy; see `createAlertPolicy`. */
  minSourcesKey: string
  /** The event types the application raises that alert hygiene treats specially. */
  events: {
    /** Rate-capped per source; the only event a quiet-hours or throttle rule can drop. */
    alert: string
    /** Closes an alert. Together with `alert` it tells whether a source still has an alert open. */
    recovery: string
    /** Never folded into a digest. */
    ungrouped: string
  }
  /** Sends one delivery's variables through the channel. Throws on failure. */
  deliver: (channel: ChannelRow, vars: Record<string, string>) => Promise<void>
  /** The notification that stands in for several single-source events: its variables and the name it is recorded under. */
  digest: (rows: DeliveryRow[], now: number) => { vars: Record<string, string>; sourceName: string }
  /** Resolves a vault reference to its secret fields (used for SMTP credentials). */
  resolveSecret: (ref: VaultRef) => Promise<Record<string, string>>
}

export interface SmtpMessage {
  to: string
  subject: string
  text: string
  /** Sent alongside `text` as multipart/alternative; clients that cannot render HTML show the text. */
  html?: string
  headers?: Record<string, string>
}

type DeliveryVariant =
  | { status: 'pending'; releaseAt?: number; groupKey?: string | null }
  | { status: 'suppressed'; reason: NotificationSuppressionReason }

interface DeliveryPlan {
  /** When the delivery may first be attempted. */
  releaseAt: number
  /** Digest window this delivery belongs to, or null when it stands alone. */
  groupKey: string | null
  suppressionReason: NotificationSuppressionReason | null
}

/** Delivery history older than this is purged. */
const DELIVERY_RETENTION_MS = 180 * 24 * 60 * 60 * 1000

/**
 * The delivery engine: records every notification, applies the channel's alert hygiene, sends with retries, folds
 * bursts into digests and sends SMTP mail. Locks and in-flight sets live in the returned closure, so two engines
 * never share state.
 */
export function createNotifyEngine(options: NotifyEngineOptions) {
  const { db, deliver, resolveSecret } = options
  const { notificationChannels, notificationDeliveries, notificationDeliveryAttempts, smtpSettings } = options.tables
  const { parseAlertPolicy } = createAlertPolicy({ minSourcesKey: options.minSourcesKey })
  const activeDeliveries = new Set<number>()

  /**
   * Writes one delivery row. A pending row is picked up for sending at `releaseAt`; a suppressed row
   * records an event that alert hygiene dropped, so the history still shows what was not sent.
   */
  async function insertDelivery(
    channel: ChannelRow,
    vars: Record<string, string>,
    details: DeliveryDetails,
    variant: DeliveryVariant,
  ): Promise<number> {
    const now = Date.now()
    const [delivery] = await db.insert(notificationDeliveries).values({
      channelId: channel.id,
      channelName: channel.name,
      channelType: channel.type,
      sourceId: details.sourceId,
      sourceName: details.sourceName,
      eventType: details.eventType,
      status: variant.status,
      targetStatus: vars['status'] ?? 'unknown',
      previousStatus: vars['previous_status'] ?? 'unknown',
      variables: JSON.stringify(vars),
      attemptCount: 0,
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
      ...(variant.status === 'pending'
        ? { nextAttemptAt: variant.releaseAt ?? now, groupKey: variant.groupKey ?? null }
        : { nextAttemptAt: null, suppressionReason: variant.reason }),
      createdAt: now,
      updatedAt: now,
    }).returning({ id: notificationDeliveries.id })
    return delivery!.id
  }

  async function attemptDelivery(deliveryId: number, now = Date.now()): Promise<void> {
    if (activeDeliveries.has(deliveryId)) return
    activeDeliveries.add(deliveryId)
    try {
      const delivery = (await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, deliveryId)))[0]
      if (!delivery || delivery.status === 'delivered' || delivery.attemptCount >= delivery.maxAttempts) return
      const channel = (await db.select().from(notificationChannels).where(eq(notificationChannels.id, delivery.channelId)))[0]
      const attemptNumber = delivery.attemptCount + 1
      const startedAt = Date.now()
      try {
        if (!channel) throw new Error('Notification channel no longer exists')
        if (channel.enabled !== 1) throw new Error('Notification channel is disabled')
        await deliver(channel, JSON.parse(delivery.variables) as Record<string, string>)
        const completedAt = Date.now()
        await db.insert(notificationDeliveryAttempts).values({ deliveryId, attemptNumber, status: 'delivered', error: null, startedAt, completedAt })
        await db.update(notificationDeliveries).set({
          status: 'delivered', attemptCount: attemptNumber, nextAttemptAt: null,
          lastAttemptAt: completedAt, deliveredAt: completedAt, lastError: null, updatedAt: completedAt,
        }).where(eq(notificationDeliveries.id, deliveryId))
      } catch (error) {
        const completedAt = Date.now()
        const message = error instanceof Error ? error.message : String(error)
        const exhausted = attemptNumber >= delivery.maxAttempts
        const delay = RETRY_DELAYS_MS[Math.min(attemptNumber - 1, RETRY_DELAYS_MS.length - 1)]!
        await db.insert(notificationDeliveryAttempts).values({ deliveryId, attemptNumber, status: 'failed', error: message, startedAt, completedAt })
        await db.update(notificationDeliveries).set({
          status: exhausted ? 'failed' : 'pending', attemptCount: attemptNumber,
          nextAttemptAt: exhausted ? null : now + delay, lastAttemptAt: completedAt,
          lastError: message, updatedAt: completedAt,
        }).where(eq(notificationDeliveries.id, deliveryId))
        console.error(`[notifier] Delivery ${deliveryId}, attempt ${attemptNumber} failed: ${message}`)
      }
    } finally { activeDeliveries.delete(deliveryId) }
  }

  // ── Alert hygiene: rate caps, quiet hours and digest windows ───────────────

  /** Alerts already sent or queued for this source on this channel inside the throttle window. */
  async function countRecentAlerts(channelId: number, sourceId: number, windowStart: number): Promise<number> {
    const [row] = await db.select({ count: sql<number>`count(*)` }).from(notificationDeliveries).where(and(
      eq(notificationDeliveries.channelId, channelId),
      eq(notificationDeliveries.sourceId, sourceId),
      eq(notificationDeliveries.eventType, options.events.alert),
      ne(notificationDeliveries.status, 'suppressed'),
      gte(notificationDeliveries.createdAt, windowStart),
    ))
    return row?.count ?? 0
  }

  /** The digest window this channel already has open, so a burst lands in a single group. */
  async function findOpenGroup(channelId: number, eventType: string, now: number): Promise<{ groupKey: string; releaseAt: number } | null> {
    const [row] = await db.select({ groupKey: notificationDeliveries.groupKey, releaseAt: notificationDeliveries.nextAttemptAt })
      .from(notificationDeliveries)
      .where(and(
        eq(notificationDeliveries.channelId, channelId),
        eq(notificationDeliveries.status, 'pending'),
        like(notificationDeliveries.groupKey, `ch${channelId}:${eventType}:w%`),
        gt(notificationDeliveries.nextAttemptAt, now),
      ))
      .orderBy(asc(notificationDeliveries.nextAttemptAt))
      .limit(1)
    return row?.groupKey && row.releaseAt !== null ? { groupKey: row.groupKey, releaseAt: row.releaseAt } : null
  }

  /**
   * Applies a channel's alert hygiene to one event. Order matters: the rate cap runs first so a
   * throttled alert never holds a digest window open, then quiet hours decide whether the event is
   * dropped or held, then grouping decides which digest it joins.
   */
  async function planDelivery(
    channel: ChannelRow,
    policy: AlertPolicy,
    details: DeliveryDetails,
    now: number,
  ): Promise<DeliveryPlan> {
    // Recoveries are never throttled — the all-clear must always get through.
    if (policy.throttle.enabled && details.eventType === options.events.alert && details.sourceId !== null) {
      const windowStart = now - policy.throttle.windowMinutes * 60_000
      const recent = await countRecentAlerts(channel.id, details.sourceId, windowStart)
      if (recent >= policy.throttle.maxAlerts) return { releaseAt: now, groupKey: null, suppressionReason: 'throttled' }
    }

    let releaseAt = now
    let quietUntil: number | null = null
    if (isWithinQuietHours(policy.quietHours, now)) {
      if (policy.quietHours.mode === 'suppress') return { releaseAt: now, groupKey: null, suppressionReason: 'quiet-hours' }
      quietUntil = quietHoursEndAt(policy.quietHours, now)
      releaseAt = Math.max(releaseAt, quietUntil)
    }

    let groupKey: string | null = null
    if (policy.grouping.enabled && details.eventType !== options.events.ungrouped) {
      if (quietUntil !== null) {
        // Everything held for the same quiet window is released at once — digest it as one message.
        groupKey = `ch${channel.id}:${details.eventType}:q${quietUntil}`
      } else {
        const open = await findOpenGroup(channel.id, details.eventType, now)
        if (open) {
          groupKey = open.groupKey
          releaseAt = Math.max(releaseAt, open.releaseAt)
        } else {
          groupKey = `ch${channel.id}:${details.eventType}:w${now}`
          releaseAt = Math.max(releaseAt, now + policy.grouping.windowSeconds * 1000)
        }
      }
    }

    return { releaseAt, groupKey, suppressionReason: null }
  }

  /**
   * Planning reads a channel's recent deliveries and then writes one. Two events for the same
   * channel must not interleave across those awaits, or a burst — precisely what grouping exists
   * for — would open one digest window per source, and a rate cap would be counted from a stale
   * total. Sending happens outside the lock so a slow endpoint never stalls the queue.
   */
  const channelLocks = new Map<number, Promise<unknown>>()

  function withChannelLock<T>(channelId: number, work: () => Promise<T>): Promise<T> {
    const previous = channelLocks.get(channelId) ?? Promise.resolve()
    const next = previous.then(work, work)
    channelLocks.set(channelId, next.catch(() => undefined))
    return next
  }

  /**
   * Collapses every due digest window into a single notification. A window that did not reach
   * `minSources` distinct sources is simply released as ordinary individual deliveries, so
   * grouping costs at most `windowSeconds` of latency and never swallows a lone alert.
   */
  let flushChain: Promise<unknown> = Promise.resolve()

  function flushGroups(now = Date.now()): Promise<number> {
    // The retry worker fires every 30s without awaiting the previous pass; overlapping flushes
    // would each turn the same window into its own digest.
    const run = () => flushDueGroups(now)
    const next = flushChain.then(run, run)
    flushChain = next.catch(() => undefined)
    return next
  }

  async function flushDueGroups(now: number): Promise<number> {
    const pending = await db.select().from(notificationDeliveries).where(and(
      eq(notificationDeliveries.status, 'pending'),
      isNotNull(notificationDeliveries.groupKey),
      lte(notificationDeliveries.nextAttemptAt, now),
    )).orderBy(asc(notificationDeliveries.createdAt))
    if (pending.length === 0) return 0

    const groups = new Map<string, DeliveryRow[]>()
    for (const row of pending) {
      const bucket = groups.get(row.groupKey!)
      if (bucket) bucket.push(row)
      else groups.set(row.groupKey!, [row])
    }

    let digests = 0
    for (const rows of groups.values()) {
      const ids = rows.map((row) => row.id)
      const channel = (await db.select().from(notificationChannels).where(eq(notificationChannels.id, rows[0]!.channelId)))[0]
      const policy = channel ? parseAlertPolicy(channel.alertPolicy) : null
      const distinctSources = new Set(rows.map((row) => row.sourceId ?? -row.id)).size

      if (!channel || !policy?.grouping.enabled || distinctSources < policy.grouping.minSources) {
        // Not a burst — or grouping was switched off mid-window. Send them individually.
        await db.update(notificationDeliveries).set({ groupKey: null, updatedAt: now })
          .where(inArray(notificationDeliveries.id, ids))
        continue
      }

      const { vars, sourceName } = options.digest(rows, now)
      // Retire the members first: a crash between the two writes must not let both forms go out.
      await db.update(notificationDeliveries).set({
        status: 'suppressed', suppressionReason: 'grouped', nextAttemptAt: null, updatedAt: now,
      }).where(inArray(notificationDeliveries.id, ids))
      await insertDelivery(channel, vars, {
        sourceId: null,
        sourceName,
        eventType: rows[0]!.eventType,
      }, { status: 'pending', releaseAt: now })
      digests++
    }
    return digests
  }

  async function processDue(now = Date.now()): Promise<number> {
    await flushGroups(now)
    const due = await db.select({ id: notificationDeliveries.id }).from(notificationDeliveries).where(
      and(eq(notificationDeliveries.status, 'pending'), lte(notificationDeliveries.nextAttemptAt, now)),
    )
    await Promise.allSettled(due.map((delivery) => attemptDelivery(delivery.id, now)))
    return due.length
  }

  async function retryDelivery(deliveryId: number): Promise<boolean> {
    const delivery = (await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, deliveryId)))[0]
    if (!delivery || delivery.status !== 'failed') return false
    const now = Date.now()
    await db.update(notificationDeliveries).set({
      status: 'pending', maxAttempts: delivery.attemptCount + MAX_DELIVERY_ATTEMPTS,
      nextAttemptAt: now, deliveredAt: null, lastError: null, updatedAt: now,
    }).where(eq(notificationDeliveries.id, deliveryId))
    await attemptDelivery(deliveryId, now)
    return true
  }

  async function purgeOldDeliveries(now = Date.now()): Promise<void> {
    await db.delete(notificationDeliveries).where(lt(notificationDeliveries.createdAt, now - DELIVERY_RETENTION_MS))
  }

  /** True when the latest alert-or-recovery event recorded for this source is an alert. */
  async function hasOpenAlert(sourceId: number): Promise<boolean> {
    // Suppressed rows count: an alert that quiet hours or a digest swallowed was still raised.
    const [last] = await db.select({ eventType: notificationDeliveries.eventType }).from(notificationDeliveries)
      .where(and(
        eq(notificationDeliveries.sourceId, sourceId),
        inArray(notificationDeliveries.eventType, [options.events.alert, options.events.recovery]),
      ))
      .orderBy(desc(notificationDeliveries.id))
      .limit(1)
    return last?.eventType === options.events.alert
  }

  /**
   * Plans one event for one channel under its lock and records it. Resolves to the delivery to send right away, or
   * null when nothing is to be sent now (suppressed, or held for quiet hours or a digest window). Recording is
   * separate from sending so a caller can record every channel's delivery in its own transaction and send afterwards:
   * a recorded delivery that was never sent is picked up by `processDue`.
   */
  async function plan(channel: ChannelRow, vars: Record<string, string>, details: DeliveryDetails): Promise<number | null> {
    return withChannelLock(channel.id, async () => {
      const now = Date.now()
      const delivery = await planDelivery(channel, parseAlertPolicy(channel.alertPolicy), details, now)

      if (delivery.suppressionReason) {
        await insertDelivery(channel, vars, details, { status: 'suppressed', reason: delivery.suppressionReason })
        return null
      }

      const deliveryId = await insertDelivery(channel, vars, details, { status: 'pending', releaseAt: delivery.releaseAt, groupKey: delivery.groupKey })
      return delivery.releaseAt <= now ? deliveryId : null
    })
  }

  /** Plans one event for one channel and sends it right away when nothing holds it back. */
  async function dispatch(channel: ChannelRow, vars: Record<string, string>, details: DeliveryDetails): Promise<void> {
    const sendNow = await plan(channel, vars, details)
    if (sendNow !== null) await attemptDelivery(sendNow)
  }

  /** Records a delivery that bypasses alert hygiene and sends it at once; resolves to the outcome. */
  async function sendDirect(
    channel: ChannelRow,
    vars: Record<string, string>,
    details: DeliveryDetails,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const deliveryId = await insertDelivery(channel, vars, details, { status: 'pending' })
    await attemptDelivery(deliveryId)
    const delivery = (await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, deliveryId)))[0]!
    return delivery.status === 'delivered' ? { ok: true } : { ok: false, error: delivery.lastError ?? 'Delivery failed' }
  }

  // ── SMTP ───────────────────────────────────────────────────────────────────

  async function isSmtpConfigured(): Promise<boolean> {
    const smtp = (await db.select({ host: smtpSettings.host }).from(smtpSettings))[0]
    return !!smtp?.host
  }

  /** Sends one message through the configured SMTP server. Throws when SMTP is not set up. */
  async function sendSmtpMail(message: SmtpMessage): Promise<void> {
    const smtp = (await db.select().from(smtpSettings))[0]
    if (!smtp?.host) throw new Error('SMTP not configured')

    let smtpUser = smtp.user
    let smtpPass = smtp.password
    if (smtp.vaultConfig) {
      const ref = JSON.parse(smtp.vaultConfig) as VaultRef
      const creds = await resolveSecret(ref)
      smtpUser = creds['username'] ?? creds['user'] ?? smtpUser
      smtpPass = creds['password'] ?? creds['value'] ?? smtpPass
      // A vault reference means sign-in was intended; without a user nodemailer would skip auth silently.
      if (!smtpUser) throw new Error('SMTP vault secret has no username: use a User / Password secret or map a username in a JSON secret')
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodemailer: any = await import('nodemailer')
    const nm = nodemailer.default ?? nodemailer
    const transporter = nm.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: !!smtp.secure,
      auth: smtpUser ? { user: smtpUser, pass: smtpPass } : undefined,
    })

    const from = smtp.fromAddress
      ? `"${smtp.fromName}" <${smtp.fromAddress}>`
      : smtp.fromName

    await transporter.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(message.headers ? { headers: message.headers } : {}),
    })
  }

  return {
    plan, dispatch, sendDirect, attemptDelivery, flushGroups, processDue, retryDelivery, purgeOldDeliveries, hasOpenAlert,
    isSmtpConfigured, sendSmtpMail,
  }
}

export type NotifyEngine = ReturnType<typeof createNotifyEngine>
