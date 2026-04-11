import { db } from '../db/client.js'
import { monitors, notificationChannels, monitorNotificationChannels, smtpSettings } from '../db/schema.js'
import { eq, inArray } from 'drizzle-orm'
import { resolveVaultSecret } from './resolveSecret.js'
import type { MonitorStatus, VaultRef } from '@bsp/shared'

function substituteVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`)
}

export async function sendNotifications(
  monitor: typeof monitors.$inferSelect,
  newStatus: MonitorStatus,
  prevStatus: string,
  errorMessage: string | null,
) {
  const isDown = newStatus === 'down' || newStatus === 'degraded'
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

    const config = JSON.parse(channel.config) as Record<string, unknown>

    try {
      if (channel.type === 'email') {
        await sendEmail(config as { to: string; subject: string; body: string }, vars)
      } else if (channel.type === 'webhook') {
        await sendWebhook(
          config as { url: string; method: string; headers?: Record<string, string>; body?: string },
          vars,
        )
      } else if (channel.type === 'discord') {
        await sendDiscord(
          config as { webhookUrl: string; username?: string; avatarUrl?: string; content?: string },
          vars,
        )
      }
    } catch (err) {
      console.error(`[notifier] Channel ${channel.id} (${channel.type}) failed:`, err instanceof Error ? err.message : err)
    }
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

  const config = JSON.parse(channel.config) as Record<string, unknown>

  try {
    if (channel.type === 'email') {
      await sendEmail(config as { to: string; subject: string; body: string }, vars)
    } else if (channel.type === 'webhook') {
      await sendWebhook(
        config as { url: string; method: string; headers?: Record<string, string>; body?: string },
        vars,
      )
    } else if (channel.type === 'discord') {
      await sendDiscord(
        config as { webhookUrl: string; username?: string; avatarUrl?: string; content?: string },
        vars,
      )
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
