import { db } from '../db/client.js'
import { monitors, notificationChannels, monitorNotificationChannels, smtpSettings, notificationDeliveries, notificationDeliveryAttempts } from '../db/schema.js'
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, like, lt, lte, ne, sql } from 'drizzle-orm'
import { resolveVaultSecret } from './resolveSecret.js'
import { isWithinQuietHours, parseAlertPolicy, quietHoursEndAt } from '../services/alertPolicy.js'
import type { ChannelAlertPolicy, MonitorStatus, NotificationSuppressionReason, VaultRef } from '@bsp/shared'

function substituteVars(template: string, vars: Record<string, string>, escape?: (value: string) => string): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key]
    return value === undefined ? `{{${key}}}` : escape ? escape(value) : value
  })
}

/** Escapes a value for use inside a JSON string literal in a template. */
function escapeJsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

const MAX_DELIVERY_ATTEMPTS = 3
const RETRY_DELAYS_MS = [60_000, 5 * 60_000]
const activeDeliveries = new Set<number>()

type ChannelRow = typeof notificationChannels.$inferSelect

async function deliverToChannel(channel: ChannelRow, vars: Record<string, string>): Promise<void> {
  const config = JSON.parse(channel.config) as Record<string, unknown>
  if (channel.type === 'email') {
    await sendEmail(config as { to: string; subject: string; body: string }, vars)
  } else if (channel.type === 'webhook') {
    await sendWebhook(config as { url: string; method: string; headers?: Record<string, string>; body?: string }, vars)
  } else if (channel.type === 'discord') {
    await sendDiscord(config as { webhookUrl: string; username?: string; avatarUrl?: string; content?: string }, vars)
  } else if (channel.type === 'teams') {
    await sendTeams(config as { webhookUrl: string; summary?: string }, vars)
  } else if (channel.type === 'slack') {
    await sendSlack(config as { webhookUrl: string; text?: string }, vars)
  } else if (channel.type === 'telegram') {
    await sendTelegram(config as { botToken: string; chatId: string; text?: string }, vars)
  } else {
    throw new Error(`Unsupported notification channel type: ${channel.type}`)
  }
}

interface DeliveryDetails {
  monitorId: number | null
  monitorName: string
  eventType: string
}

type DeliveryVariant =
  | { status: 'pending'; releaseAt?: number; groupKey?: string | null }
  | { status: 'suppressed'; reason: NotificationSuppressionReason }

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
    monitorId: details.monitorId,
    monitorName: details.monitorName,
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

export async function attemptNotificationDelivery(deliveryId: number, now = Date.now()): Promise<void> {
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
      await deliverToChannel(channel, JSON.parse(delivery.variables) as Record<string, string>)
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

// ── Alert hygiene: rate caps, quiet hours and digest windows ─────────────────

type DeliveryRow = typeof notificationDeliveries.$inferSelect

interface DeliveryPlan {
  /** When the delivery may first be attempted. */
  releaseAt: number
  /** Digest window this delivery belongs to, or null when it stands alone. */
  groupKey: string | null
  suppressionReason: NotificationSuppressionReason | null
}

/** Alerts already sent or queued for this monitor on this channel inside the throttle window. */
async function countRecentAlerts(channelId: number, monitorId: number, windowStart: number): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(notificationDeliveries).where(and(
    eq(notificationDeliveries.channelId, channelId),
    eq(notificationDeliveries.monitorId, monitorId),
    eq(notificationDeliveries.eventType, 'alert'),
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
  policy: ChannelAlertPolicy,
  details: DeliveryDetails,
  now: number,
): Promise<DeliveryPlan> {
  // Recoveries are never throttled — the all-clear must always get through.
  if (policy.throttle.enabled && details.eventType === 'alert' && details.monitorId !== null) {
    const windowStart = now - policy.throttle.windowMinutes * 60_000
    const recent = await countRecentAlerts(channel.id, details.monitorId, windowStart)
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
  if (policy.grouping.enabled) {
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
 * for — would open one digest window per monitor, and a rate cap would be counted from a stale
 * total. Sending happens outside the lock so a slow endpoint never stalls the queue.
 */
const channelLocks = new Map<number, Promise<unknown>>()

function withChannelLock<T>(channelId: number, work: () => Promise<T>): Promise<T> {
  const previous = channelLocks.get(channelId) ?? Promise.resolve()
  const next = previous.then(work, work)
  channelLocks.set(channelId, next.catch(() => undefined))
  return next
}

function worstStatus(rows: DeliveryRow[]): string {
  if (rows.some((row) => row.targetStatus === 'down')) return 'down'
  if (rows.some((row) => row.targetStatus === 'degraded')) return 'degraded'
  return rows[0]?.targetStatus ?? 'unknown'
}

function readVars(row: DeliveryRow): Record<string, string> {
  try {
    return JSON.parse(row.variables) as Record<string, string>
  } catch {
    return {}
  }
}

/** Builds the template variables for a digest that stands in for several single-monitor events. */
function digestVars(rows: DeliveryRow[], now: number): Record<string, string> {
  const names = rows.map((row) => row.monitorName)
  const previous = new Set(rows.map((row) => row.previousStatus))
  const lines = rows.map((row) => {
    const detail = readVars(row)['error_message']
    return detail ? `${row.monitorName} → ${row.targetStatus}: ${detail}` : `${row.monitorName} → ${row.targetStatus}`
  })
  return {
    monitor_name: `${rows.length} monitors`,
    monitor_type: 'group',
    status: worstStatus(rows),
    previous_status: previous.size === 1 ? [...previous][0]! : 'various',
    error_message: lines.join('\n'),
    checked_at: new Date(now).toISOString(),
    event_type: rows[0]?.eventType ?? 'alert',
    monitor_list: names.join(', '),
    affected_count: String(rows.length),
  }
}

/**
 * Collapses every due digest window into a single notification. A window that did not reach
 * `minMonitors` distinct monitors is simply released as ordinary individual deliveries, so
 * grouping costs at most `windowSeconds` of latency and never swallows a lone alert.
 */
let flushChain: Promise<unknown> = Promise.resolve()

export function flushNotificationGroups(now = Date.now()): Promise<number> {
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
    const distinctMonitors = new Set(rows.map((row) => row.monitorId ?? -row.id)).size

    if (!channel || !policy?.grouping.enabled || distinctMonitors < policy.grouping.minMonitors) {
      // Not a burst — or grouping was switched off mid-window. Send them individually.
      await db.update(notificationDeliveries).set({ groupKey: null, updatedAt: now })
        .where(inArray(notificationDeliveries.id, ids))
      continue
    }

    const vars = digestVars(rows, now)
    // Retire the members first: a crash between the two writes must not let both forms go out.
    await db.update(notificationDeliveries).set({
      status: 'suppressed', suppressionReason: 'grouped', nextAttemptAt: null, updatedAt: now,
    }).where(inArray(notificationDeliveries.id, ids))
    await insertDelivery(channel, vars, {
      monitorId: null,
      monitorName: vars['monitor_name']!,
      eventType: rows[0]!.eventType,
    }, { status: 'pending', releaseAt: now })
    digests++
  }
  return digests
}

export async function processDueNotificationDeliveries(now = Date.now()): Promise<number> {
  await flushNotificationGroups(now)
  const due = await db.select({ id: notificationDeliveries.id }).from(notificationDeliveries).where(
    and(eq(notificationDeliveries.status, 'pending'), lte(notificationDeliveries.nextAttemptAt, now)),
  )
  await Promise.allSettled(due.map((delivery) => attemptNotificationDelivery(delivery.id, now)))
  return due.length
}

export async function retryNotificationDelivery(deliveryId: number): Promise<boolean> {
  const delivery = (await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, deliveryId)))[0]
  if (!delivery || delivery.status !== 'failed') return false
  const now = Date.now()
  await db.update(notificationDeliveries).set({
    status: 'pending', maxAttempts: delivery.attemptCount + MAX_DELIVERY_ATTEMPTS,
    nextAttemptAt: now, deliveredAt: null, lastError: null, updatedAt: now,
  }).where(eq(notificationDeliveries.id, deliveryId))
  await attemptNotificationDelivery(deliveryId, now)
  return true
}

export async function purgeOldNotificationDeliveries(now = Date.now()): Promise<void> {
  const cutoff = now - 180 * 24 * 60 * 60 * 1000
  await db.delete(notificationDeliveries).where(lt(notificationDeliveries.createdAt, cutoff))
}

/** True when the latest alert-or-recovery event recorded for this monitor is an alert. */
async function hasOpenAlert(monitorId: number): Promise<boolean> {
  // Suppressed rows count: an alert that quiet hours or a digest swallowed was still raised.
  const [last] = await db.select({ eventType: notificationDeliveries.eventType }).from(notificationDeliveries)
    .where(and(
      eq(notificationDeliveries.monitorId, monitorId),
      inArray(notificationDeliveries.eventType, ['alert', 'recovery']),
    ))
    .orderBy(desc(notificationDeliveries.id))
    .limit(1)
  return last?.eventType === 'alert'
}

export async function sendNotifications(
  monitor: typeof monitors.$inferSelect,
  newStatus: MonitorStatus,
  prevStatus: string,
  errorMessage: string | null,
) {
  const isDown = newStatus === 'down' || newStatus === 'degraded'
  // 'affected' = monitor failed but a dependency is already down — suppress alert (root cause fires its own)
  // Recovery from 'affected' is suppressed too, unless this monitor had alerted on its own before it
  // became affected (down → affected → up): that alert is still open and owes an all-clear.
  const isRecovery = newStatus === 'up' && (
    prevStatus === 'down' || prevStatus === 'degraded' ||
    (prevStatus === 'affected' && await hasOpenAlert(monitor.id))
  )
  if (!isDown && !isRecovery) return

  const channels = await linkedChannels(monitor.id)
  if (channels.length === 0) return

  const eventType = isRecovery ? 'recovery' : 'alert'
  const vars: Record<string, string> = {
    monitor_name: monitor.name,
    monitor_type: monitor.type,
    status: newStatus,
    previous_status: prevStatus,
    error_message: errorMessage ?? '',
    checked_at: new Date().toISOString(),
    event_type: eventType,
    // Digest-only variables, filled in for single events so templates never render a raw {{tag}}.
    monitor_list: monitor.name,
    affected_count: '1',
  }

  for (const channel of channels) {
    if (channel.enabled !== 1) continue
    if (isRecovery && channel.notifyOnRecovery !== 1) continue
    await dispatchToChannel(channel, vars, { monitorId: monitor.id, monitorName: monitor.name, eventType })
  }
}

export interface CertificateEvent {
  kind: 'expiring' | 'renewed'
  host: string
  expiresAt: number
  daysLeft: number
}

/** "in 5 days" / "in less than a day" — whole days, rounded down, so a warning never overstates the time left. */
export function expiresInPhrase(daysLeft: number): string {
  const days = Math.floor(daysLeft)
  if (days < 1) return 'in less than a day'
  return `in ${days} day${days === 1 ? '' : 's'}`
}

/**
 * Warns the monitor's channels that its TLS certificate is about to expire, or that the certificate
 * they were warned about has been renewed. The renewal is an all-clear, so it follows the channel's
 * "notify on recovery" switch; both go through the channel's alert hygiene like any other event.
 */
export async function sendCertificateNotifications(monitor: typeof monitors.$inferSelect, event: CertificateEvent) {
  const channels = await linkedChannels(monitor.id)
  if (channels.length === 0) return

  const expiresAt = new Date(event.expiresAt).toISOString()
  const expiresIn = expiresInPhrase(event.daysLeft)
  const vars: Record<string, string> = {
    monitor_name: monitor.name,
    monitor_type: monitor.type,
    status: event.kind === 'expiring' ? 'cert-expiring' : 'cert-renewed',
    previous_status: monitor.currentStatus,
    error_message: event.kind === 'expiring'
      ? `TLS certificate for ${event.host} expires ${expiresIn} (${expiresAt})`
      : `TLS certificate for ${event.host} was renewed and now expires ${expiresAt}`,
    checked_at: new Date().toISOString(),
    event_type: 'certificate',
    cert_host: event.host,
    cert_expires_at: expiresAt,
    cert_expires_in: expiresIn,
    cert_days_left: String(Math.max(0, Math.floor(event.daysLeft))),
    monitor_list: monitor.name,
    affected_count: '1',
  }

  for (const channel of channels) {
    if (channel.enabled !== 1) continue
    if (event.kind === 'renewed' && channel.notifyOnRecovery !== 1) continue
    await dispatchToChannel(channel, vars, { monitorId: monitor.id, monitorName: monitor.name, eventType: 'certificate' })
  }
}

async function linkedChannels(monitorId: number): Promise<ChannelRow[]> {
  const links = await db.select().from(monitorNotificationChannels)
    .where(eq(monitorNotificationChannels.monitorId, monitorId))
  if (links.length === 0) return []
  return db.select().from(notificationChannels)
    .where(inArray(notificationChannels.id, links.map((l) => l.channelId)))
}

/** Plans one event for one channel under its lock, records it, and sends it right away when nothing holds it back. */
async function dispatchToChannel(channel: ChannelRow, vars: Record<string, string>, details: DeliveryDetails): Promise<void> {
  const sendNow = await withChannelLock(channel.id, async () => {
    const now = Date.now()
    const plan = await planDelivery(channel, parseAlertPolicy(channel.alertPolicy), details, now)

    if (plan.suppressionReason) {
      await insertDelivery(channel, vars, details, { status: 'suppressed', reason: plan.suppressionReason })
      return null
    }

    const deliveryId = await insertDelivery(channel, vars, details, { status: 'pending', releaseAt: plan.releaseAt, groupKey: plan.groupKey })
    return plan.releaseAt <= now ? deliveryId : null
  })

  if (sendNow !== null) await attemptNotificationDelivery(sendNow)
}

async function sendEmail(
  config: { to: string; subject: string; body: string },
  vars: Record<string, string>,
) {
  await sendSmtpMail({
    to: substituteVars(config.to, vars),
    subject: substituteVars(config.subject, vars),
    text: substituteVars(config.body, vars),
  })
}

export async function isSmtpConfigured(): Promise<boolean> {
  const smtp = (await db.select({ host: smtpSettings.host }).from(smtpSettings))[0]
  return !!smtp?.host
}

/** Sends one message through the configured SMTP server. Throws when SMTP is not set up. */
export async function sendSmtpMail(message: {
  to: string
  subject: string
  text: string
  /** Sent alongside `text` as multipart/alternative; clients that cannot render HTML show the text. */
  html?: string
  headers?: Record<string, string>
}): Promise<void> {
  const smtp = (await db.select().from(smtpSettings))[0]
  if (!smtp?.host) throw new Error('SMTP not configured')

  let smtpUser = smtp.user
  let smtpPass = smtp.password
  if (smtp.vaultConfig) {
    const ref = JSON.parse(smtp.vaultConfig) as VaultRef
    const creds = await resolveVaultSecret(ref)
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

const OUTBOUND_TIMEOUT_MS = 15_000

/** One outbound notification request; a non-2xx answer fails the delivery as `<failurePrefix> <status>`. */
async function sendHttp(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  failurePrefix: string,
): Promise<void> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${failurePrefix} ${res.status}`)
}

function postWebhookJson(url: string, payload: unknown, label: string): Promise<void> {
  return sendHttp(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, `${label} webhook returned HTTP`)
}

async function sendWebhook(
  config: { url: string; method: string; headers?: Record<string, string>; body?: string },
  vars: Record<string, string>,
) {
  const url = substituteVars(config.url, vars)
  const body = config.body ? substituteVars(config.body, vars, escapeJsonString) : undefined

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.headers) {
    for (const [k, v] of Object.entries(config.headers)) {
      headers[k] = substituteVars(v, vars)
    }
  }

  await sendHttp(url, { method: config.method ?? 'POST', headers, ...(body !== undefined ? { body } : {}) }, 'HTTP')
}

type Severity = 'down' | 'degraded' | 'up'

/** The colour family the rich channels paint an event in. */
function severityOf(status: string | undefined): Severity {
  if (status === 'up' || status === 'cert-renewed') return 'up'
  if (status === 'degraded' || status === 'cert-expiring') return 'degraded'
  return 'down'
}

const SEVERITY_EMOJI: Record<Severity, string> = { down: '🔴', degraded: '🟡', up: '🟢' }

/** A certificate event carries details, not an error. */
function detailLabel(vars: Record<string, string>): string {
  return vars['event_type'] === 'certificate' ? 'Details' : 'Error'
}

/** Headline of a certificate event; null for status events, which each channel words itself. */
function certificateHeadline(vars: Record<string, string>, strong: (text: string) => string): string | null {
  if (vars['event_type'] !== 'certificate') return null
  const name = strong(vars['monitor_name'] ?? 'Unknown monitor')
  if (vars['status'] === 'cert-renewed') return `TLS certificate of ${name} was renewed`
  // A digest has no single expiry to quote.
  return vars['cert_expires_in'] ? `TLS certificate of ${name} expires ${vars['cert_expires_in']}` : `TLS certificates expiring: ${name}`
}

// Discord only accepts a public image URL for a webhook avatar; it cannot be uploaded as a file.
const DISCORD_DEFAULT_AVATAR_URL = 'https://docs.betterstatuspage.dev/discord-avatar.png'
const DISCORD_COLORS ={ down: 0xe53935, degraded: 0xfb8c00, up: 0x43a047 } as const

async function sendDiscord(
  config: { webhookUrl: string; username?: string; avatarUrl?: string; content?: string },
  vars: Record<string, string>,
) {
  const status = vars['status'] ?? 'unknown'
  const color = DISCORD_COLORS[severityOf(status)]

  const embed = {
    title: certificateHeadline(vars, (text) => `\`${text}\``) ?? `Monitor \`${vars['monitor_name']}\` is **${status.toUpperCase()}**`,
    color,
    fields: [
      { name: 'Status', value: vars['status'], inline: true },
      { name: 'Previous', value: vars['previous_status'], inline: true },
      { name: 'Type', value: vars['monitor_type'], inline: true },
      ...(vars['error_message'] ? [{ name: detailLabel(vars), value: vars['error_message'], inline: false }] : []),
    ],
    footer: { text: `Checked at ${vars['checked_at']}` },
    timestamp: new Date().toISOString(),
  }

  const payload: Record<string, unknown> = { embeds: [embed] }
  if (config.username) payload['username'] = config.username
  payload['avatar_url'] = config.avatarUrl ? substituteVars(config.avatarUrl, vars) : DISCORD_DEFAULT_AVATAR_URL
  if (config.content) payload['content'] = substituteVars(config.content, vars)

  await postWebhookJson(config.webhookUrl, payload, 'Discord')
}

const TEAMS_COLORS = { down: 'E53935', degraded: 'FB8C00', up: '43A047' } as const

async function sendTeams(
  config: { webhookUrl: string; summary?: string },
  vars: Record<string, string>,
) {
  const statusText = vars['status'] ?? 'unknown'
  const monitorName = vars['monitor_name'] ?? 'Unknown monitor'
  const previousStatus = vars['previous_status'] ?? 'unknown'
  const monitorType = vars['monitor_type'] ?? 'unknown'
  const checkedAt = vars['checked_at'] ?? 'unknown'
  const severity = severityOf(statusText)
  const themeColor = TEAMS_COLORS[severity]
  const statusEmoji = SEVERITY_EMOJI[severity]

  const summary = config.summary
    ? substituteVars(config.summary, vars)
    : certificateHeadline(vars, (text) => text) ?? `Monitor ${monitorName} is ${statusText.toUpperCase()}`

  const facts: { name: string; value: string }[] = [
    { name: 'Status', value: statusText },
    { name: 'Previous status', value: previousStatus },
    { name: 'Monitor type', value: monitorType },
    ...(vars['error_message'] ? [{ name: detailLabel(vars), value: vars['error_message'] }] : []),
    { name: 'Checked at', value: checkedAt },
  ]

  const payload = {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    themeColor,
    summary,
    sections: [{
      activityTitle: `${statusEmoji} ${certificateHeadline(vars, (text) => `**${text}**`) ?? `**${monitorName}** is **${statusText.toUpperCase()}**`}`,
      activitySubtitle: `Previously: **${previousStatus}**`,
      facts,
      markdown: true,
    }],
  }

  await postWebhookJson(config.webhookUrl, payload, 'Teams')
}

const SLACK_COLORS = { down: '#E53935', degraded: '#FB8C00', up: '#43A047' } as const

async function sendSlack(
  config: { webhookUrl: string; text?: string },
  vars: Record<string, string>,
) {
  const statusText = vars['status'] ?? 'unknown'
  const monitorName = vars['monitor_name'] ?? 'Unknown monitor'
  const severity = severityOf(statusText)
  const color = SLACK_COLORS[severity]
  const statusEmoji = SEVERITY_EMOJI[severity]

  const headline = certificateHeadline(vars, (text) => `*${text}*`) ?? `Monitor *${monitorName}* is *${statusText.toUpperCase()}*`
  const fallbackText = `${statusEmoji} ${headline}`

  const fields = [
    { type: 'mrkdwn', text: `*Status:*\n${vars['status']}` },
    { type: 'mrkdwn', text: `*Previous:*\n${vars['previous_status']}` },
    { type: 'mrkdwn', text: `*Type:*\n${vars['monitor_type']}` },
    ...(vars['error_message'] ? [{ type: 'mrkdwn', text: `*${detailLabel(vars)}:*\n${vars['error_message']}` }] : []),
  ]

  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: fallbackText },
    },
    {
      type: 'section',
      fields,
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Checked at ${vars['checked_at']}` }],
    },
  ]

  const payload: Record<string, unknown> = {
    text: fallbackText,
    attachments: [{ color, blocks }],
  }
  if (config.text) payload['text'] = substituteVars(config.text, vars) + '\n' + fallbackText

  await postWebhookJson(config.webhookUrl, payload, 'Slack')
}

const TELEGRAM_MAX_LENGTH = 4096
/** Keeps the optional Message Text from crowding out the facts; the detail field is what gets cut to fit. */
const TELEGRAM_MAX_TEXT_LINE = 1000

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function sendTelegram(
  config: { botToken: string; chatId: string; text?: string },
  vars: Record<string, string>,
) {
  const statusText = vars['status'] ?? 'unknown'
  const monitorName = vars['monitor_name'] ?? 'Unknown monitor'
  const emoji = SEVERITY_EMOJI[severityOf(statusText)]

  const headline = certificateHeadline(vars, (text) => `<b>${escapeHtml(text)}</b>`)
    ?? `Monitor <b>${escapeHtml(monitorName)}</b> is <b>${escapeHtml(statusText.toUpperCase())}</b>`

  const detail = vars['error_message'] ? escapeHtml(vars['error_message']) : ''
  const build = (detailText: string) => [
    ...(config.text ? [escapeHtml(Array.from(substituteVars(config.text, vars)).slice(0, TELEGRAM_MAX_TEXT_LINE).join(''))] : []),
    `${emoji} ${headline}`,
    '',
    `<b>Status:</b> ${escapeHtml(statusText)}`,
    `<b>Previous:</b> ${escapeHtml(vars['previous_status'] ?? 'unknown')}`,
    `<b>Type:</b> ${escapeHtml(vars['monitor_type'] ?? 'unknown')}`,
    ...(detailText ? [`<b>${detailLabel(vars)}:</b> ${detailText}`] : []),
    `<i>Checked at ${escapeHtml(vars['checked_at'] ?? 'unknown')}</i>`,
  ].join('\n')

  // Cutting the finished message could split an HTML tag, so an oversized one loses the tail of the details field only.
  let text = build(detail)
  if (text.length > TELEGRAM_MAX_LENGTH && detail) {
    const keep = Math.max(0, detail.length - (text.length - TELEGRAM_MAX_LENGTH) - 1)
    text = build(`${detail.slice(0, keep).replace(/&[a-z]*$/, '')}…`)
  }

  // The bot token is part of the URL path. Only the status code and Telegram's own description are reported
  // (the Bot API never echoes the token), so the token never reaches the delivery history.
  const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: config.chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  })
  if (!res.ok) {
    const description = await res.json().then((j: { description?: unknown }) => typeof j.description === 'string' ? j.description : '', () => '')
    throw new Error(`Telegram API returned HTTP ${res.status}${description ? `: ${description.slice(0, 200)}` : ''}`)
  }
}

/** Send a test email directly to the given address using current SMTP settings. */
export async function testSmtp(to: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await sendEmail(
      { to, subject: 'BSP SMTP Test', body: 'This is a test email from BetterStatusPage.\n\nIf you received this, your SMTP configuration is working correctly.' },
      {},
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Send a test notification for a channel with dummy data. */
export async function testNotificationChannel(channelId: number): Promise<{ ok: boolean; error?: string }> {
  const channel = (await db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId)))[0]
  if (!channel) return { ok: false, error: 'Channel not found' }

  const vars: Record<string, string> = {
    monitor_name: 'Test Monitor',
    monitor_type: 'https',
    status: 'down',
    previous_status: 'up',
    error_message: 'This is a test notification',
    checked_at: new Date().toISOString(),
    event_type: 'test',
    monitor_list: 'Test Monitor',
    affected_count: '1',
  }

  const deliveryId = await insertDelivery(channel, vars, { monitorId: null, monitorName: 'Test Monitor', eventType: 'test' }, { status: 'pending' })
  await attemptNotificationDelivery(deliveryId)
  const delivery = (await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, deliveryId)))[0]!
  return delivery.status === 'delivered' ? { ok: true } : { ok: false, error: delivery.lastError ?? 'Delivery failed' }
}
