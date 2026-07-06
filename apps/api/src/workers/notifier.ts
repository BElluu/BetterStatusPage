import { db } from '../db/client.js'
import { monitors, notificationChannels, monitorNotificationChannels, smtpSettings, notificationDeliveries, notificationDeliveryAttempts } from '../db/schema.js'
import { and, eq, inArray, lt, lte } from 'drizzle-orm'
import { resolveVaultSecret } from './resolveSecret.js'
import type { MonitorStatus, VaultRef } from '@bsp/shared'

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

async function enqueueDelivery(
  channel: ChannelRow,
  vars: Record<string, string>,
  details: { monitorId: number | null; monitorName: string; eventType: string },
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
    nextAttemptAt: now,
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

export async function processDueNotificationDeliveries(now = Date.now()): Promise<number> {
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
  }

  for (const channel of channels) {
    if (channel.enabled !== 1) continue
    if (isRecovery && channel.notifyOnRecovery !== 1) continue

    const deliveryId = await enqueueDelivery(channel, vars, {
      monitorId: monitor.id,
      monitorName: monitor.name,
      eventType: isRecovery ? 'recovery' : 'alert',
    })
    await attemptNotificationDelivery(deliveryId)
  }
}

async function sendEmail(
  config: { to: string; subject: string; body: string },
  vars: Record<string, string>,
) {
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
    to: substituteVars(config.to, vars),
    subject: substituteVars(config.subject, vars),
    text: substituteVars(config.body, vars),
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
  }

  const deliveryId = await enqueueDelivery(channel, vars, { monitorId: null, monitorName: 'Test Monitor', eventType: 'test' })
  await attemptNotificationDelivery(deliveryId)
  const delivery = (await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, deliveryId)))[0]!
  return delivery.status === 'delivered' ? { ok: true } : { ok: false, error: delivery.lastError ?? 'Delivery failed' }
}
