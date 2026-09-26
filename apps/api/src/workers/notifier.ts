import { db } from '../db/client.js'
import { monitors, notificationChannels, monitorNotificationChannels, smtpSettings, notificationDeliveries, notificationDeliveryAttempts } from '../db/schema.js'
import { and, asc, eq, gt, gte, inArray, isNotNull, like, lt, lte, ne, sql } from 'drizzle-orm'
import { resolveVaultSecret } from './resolveSecret.js'
import { isWithinQuietHours, parseAlertPolicy, quietHoursEndAt } from '../services/alertPolicy.js'
import type { ChannelAlertPolicy, MonitorStatus, NotificationSuppressionReason, VaultRef } from '@bsp/shared'

function substituteVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`)
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
  } else {
    throw new Error(`Unsupported notification channel type: ${channel.type}`)
  }
}

interface DeliveryDetails {
  monitorId: number | null
  monitorName: string
  eventType: string
}

async function enqueueDelivery(
  channel: ChannelRow,
  vars: Record<string, string>,
  details: DeliveryDetails,
  options: { releaseAt?: number; groupKey?: string | null } = {},
): Promise<number> {
  const now = Date.now()
  const [delivery] = await db.insert(notificationDeliveries).values({
    channelId: channel.id,
    channelName: channel.name,
    channelType: channel.type,
    monitorId: details.monitorId,
    monitorName: details.monitorName,
    eventType: details.eventType,
    status: 'pending',
    targetStatus: vars['status'] ?? 'unknown',
    previousStatus: vars['previous_status'] ?? 'unknown',
    variables: JSON.stringify(vars),
    attemptCount: 0,
    maxAttempts: MAX_DELIVERY_ATTEMPTS,
    nextAttemptAt: options.releaseAt ?? now,
    groupKey: options.groupKey ?? null,
    createdAt: now,
    updatedAt: now,
  }).returning({ id: notificationDeliveries.id })
  return delivery!.id
}

/** Records an event that alert hygiene dropped, so the history still shows what was not sent. */
async function recordSuppressedDelivery(
  channel: ChannelRow,
  vars: Record<string, string>,
  details: DeliveryDetails,
  reason: NotificationSuppressionReason,
): Promise<number> {
  const now = Date.now()
  const [delivery] = await db.insert(notificationDeliveries).values({
    channelId: channel.id,
    channelName: channel.name,
    channelType: channel.type,
    monitorId: details.monitorId,
    monitorName: details.monitorName,
    eventType: details.eventType,
    status: 'suppressed',
    targetStatus: vars['status'] ?? 'unknown',
    previousStatus: vars['previous_status'] ?? 'unknown',
    variables: JSON.stringify(vars),
    attemptCount: 0,
    maxAttempts: MAX_DELIVERY_ATTEMPTS,
    nextAttemptAt: null,
    suppressionReason: reason,
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
    await enqueueDelivery(channel, vars, {
      monitorId: null,
      monitorName: vars['monitor_name']!,
      eventType: rows[0]!.eventType,
    }, { releaseAt: now })
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

export async function sendNotifications(
  monitor: typeof monitors.$inferSelect,
  newStatus: MonitorStatus,
  prevStatus: string,
  errorMessage: string | null,
) {
  const isDown = newStatus === 'down' || newStatus === 'degraded'
  // 'affected' = monitor failed but a dependency is already down — suppress alert (root cause fires its own)
  // Recovery from 'affected' also suppressed — root cause recovery notification is enough
  const isRecovery = newStatus === 'up' && (prevStatus === 'down' || prevStatus === 'degraded')
  if (!isDown && !isRecovery) return

  const links = await db.select().from(monitorNotificationChannels)
    .where(eq(monitorNotificationChannels.monitorId, monitor.id))
  if (links.length === 0) return

  const channelIds = links.map((l) => l.channelId)
  const channels = await db.select().from(notificationChannels)
    .where(inArray(notificationChannels.id, channelIds))

  const vars: Record<string, string> = {
    monitor_name: monitor.name,
    monitor_type: monitor.type,
    status: newStatus,
    previous_status: prevStatus,
    error_message: errorMessage ?? '',
    checked_at: new Date().toISOString(),
    // Digest-only variables, filled in for single events so templates never render a raw {{tag}}.
    monitor_list: monitor.name,
    affected_count: '1',
  }

  for (const channel of channels) {
    if (channel.enabled !== 1) continue
    if (isRecovery && channel.notifyOnRecovery !== 1) continue

    const details: DeliveryDetails = {
      monitorId: monitor.id,
      monitorName: monitor.name,
      eventType: isRecovery ? 'recovery' : 'alert',
    }
    const sendNow = await withChannelLock(channel.id, async () => {
      const now = Date.now()
      const plan = await planDelivery(channel, parseAlertPolicy(channel.alertPolicy), details, now)

      if (plan.suppressionReason) {
        await recordSuppressedDelivery(channel, vars, details, plan.suppressionReason)
        return null
      }

      const deliveryId = await enqueueDelivery(channel, vars, details, { releaseAt: plan.releaseAt, groupKey: plan.groupKey })
      return plan.releaseAt <= now ? deliveryId : null
    })

    if (sendNow !== null) await attemptNotificationDelivery(sendNow)
  }
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

async function sendWebhook(
  config: { url: string; method: string; headers?: Record<string, string>; body?: string },
  vars: Record<string, string>,
) {
  const url = substituteVars(config.url, vars)
  const body = config.body ? substituteVars(config.body, vars) : undefined

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.headers) {
    for (const [k, v] of Object.entries(config.headers)) {
      headers[k] = substituteVars(v, vars)
    }
  }

  const res = await fetch(url, {
    method: config.method ?? 'POST',
    headers,
    ...(body !== undefined ? { body } : {}),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

const DISCORD_COLORS = { down: 0xe53935, degraded: 0xfb8c00, up: 0x43a047 } as const

async function sendDiscord(
  config: { webhookUrl: string; username?: string; avatarUrl?: string; content?: string },
  vars: Record<string, string>,
) {
  const status = vars['status'] as keyof typeof DISCORD_COLORS
  const color = DISCORD_COLORS[status] ?? DISCORD_COLORS.down

  const embed = {
    title: `Monitor \`${vars['monitor_name']}\` is **${status.toUpperCase()}**`,
    color,
    fields: [
      { name: 'Status', value: vars['status'], inline: true },
      { name: 'Previous', value: vars['previous_status'], inline: true },
      { name: 'Type', value: vars['monitor_type'], inline: true },
      ...(vars['error_message'] ? [{ name: 'Error', value: vars['error_message'], inline: false }] : []),
    ],
    footer: { text: `Checked at ${vars['checked_at']}` },
    timestamp: new Date().toISOString(),
  }

  const payload: Record<string, unknown> = { embeds: [embed] }
  if (config.username) payload['username'] = config.username
  if (config.avatarUrl) payload['avatar_url'] = substituteVars(config.avatarUrl, vars)
  if (config.content) payload['content'] = substituteVars(config.content, vars)

  const res = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Discord webhook returned HTTP ${res.status}`)
}

const TEAMS_COLORS = { down: 'E53935', degraded: 'FB8C00', up: '43A047' } as const

async function sendTeams(
  config: { webhookUrl: string; summary?: string },
  vars: Record<string, string>,
) {
  const status = vars['status'] as keyof typeof TEAMS_COLORS
  const statusText = vars['status'] ?? 'unknown'
  const monitorName = vars['monitor_name'] ?? 'Unknown monitor'
  const previousStatus = vars['previous_status'] ?? 'unknown'
  const monitorType = vars['monitor_type'] ?? 'unknown'
  const checkedAt = vars['checked_at'] ?? 'unknown'
  const themeColor = TEAMS_COLORS[status] ?? TEAMS_COLORS.down
  const statusEmoji = status === 'down' ? '🔴' : status === 'degraded' ? '🟡' : '🟢'

  const summary = config.summary
    ? substituteVars(config.summary, vars)
    : `Monitor ${monitorName} is ${statusText.toUpperCase()}`

  const facts: { name: string; value: string }[] = [
    { name: 'Status', value: statusText },
    { name: 'Previous status', value: previousStatus },
    { name: 'Monitor type', value: monitorType },
    ...(vars['error_message'] ? [{ name: 'Error', value: vars['error_message'] }] : []),
    { name: 'Checked at', value: checkedAt },
  ]

  const payload = {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    themeColor,
    summary,
    sections: [{
      activityTitle: `${statusEmoji} **${monitorName}** is **${statusText.toUpperCase()}**`,
      activitySubtitle: `Previously: **${previousStatus}**`,
      facts,
      markdown: true,
    }],
  }

  const res = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Teams webhook returned HTTP ${res.status}`)
}

const SLACK_COLORS = { down: '#E53935', degraded: '#FB8C00', up: '#43A047' } as const

async function sendSlack(
  config: { webhookUrl: string; text?: string },
  vars: Record<string, string>,
) {
  const status = vars['status'] as keyof typeof SLACK_COLORS
  const statusText = vars['status'] ?? 'unknown'
  const monitorName = vars['monitor_name'] ?? 'Unknown monitor'
  const color = SLACK_COLORS[status] ?? SLACK_COLORS.down
  const statusEmoji = status === 'down' ? '🔴' : status === 'degraded' ? '🟡' : '🟢'

  const fallbackText = `${statusEmoji} Monitor *${monitorName}* is *${statusText.toUpperCase()}*`

  const fields = [
    { type: 'mrkdwn', text: `*Status:*\n${vars['status']}` },
    { type: 'mrkdwn', text: `*Previous:*\n${vars['previous_status']}` },
    { type: 'mrkdwn', text: `*Type:*\n${vars['monitor_type']}` },
    ...(vars['error_message'] ? [{ type: 'mrkdwn', text: `*Error:*\n${vars['error_message']}` }] : []),
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

  const res = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Slack webhook returned HTTP ${res.status}`)
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
    monitor_list: 'Test Monitor',
    affected_count: '1',
  }

  const deliveryId = await enqueueDelivery(channel, vars, { monitorId: null, monitorName: 'Test Monitor', eventType: 'test' })
  await attemptNotificationDelivery(deliveryId)
  const delivery = (await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, deliveryId)))[0]!
  return delivery.status === 'delivered' ? { ok: true } : { ok: false, error: delivery.lastError ?? 'Delivery failed' }
}
