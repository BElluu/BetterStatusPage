import { db } from '../db/client.js'
import { monitors, notificationChannels, monitorNotificationChannels, actionNotificationChannels } from '../db/schema.js'
import { eq, inArray } from 'drizzle-orm'
import { buildWebhookRequest, MAX_DELIVERY_ATTEMPTS, RETRY_DELAYS_MS } from '@better-kit/notify'
import { notifyEngine as engine, transports } from '../kit/notify.js'
import type { MonitorStatus } from '@bsp/shared'

export { buildWebhookRequest, MAX_DELIVERY_ATTEMPTS, RETRY_DELAYS_MS }

type ChannelRow = typeof notificationChannels.$inferSelect

export const attemptNotificationDelivery = engine.attemptDelivery
export const flushNotificationGroups = engine.flushGroups
export const processDueNotificationDeliveries = engine.processDue
export const retryNotificationDelivery = engine.retryDelivery
export const purgeOldNotificationDeliveries = engine.purgeOldDeliveries
export const isSmtpConfigured = engine.isSmtpConfigured
export const sendSmtpMail = engine.sendSmtpMail
const hasOpenAlert = engine.hasOpenAlert

/** Plans one event for one channel under its lock, records it, and sends it right away when nothing holds it back. */
const dispatchToChannel = (
  channel: ChannelRow,
  vars: Record<string, string>,
  details: { monitorId: number | null; monitorName: string; eventType: string },
) => engine.dispatch(channel, vars, { sourceId: details.monitorId, sourceName: details.monitorName, eventType: details.eventType })

/**
 * Records the delivery of a status change for every channel linked to the monitor, and resolves to the deliveries
 * that are due now. Nothing is sent here, so a caller can record them in the transaction that confirmed the change
 * and send after it commits; a recorded delivery that was never sent is sent by the retry worker.
 */
export async function planNotifications(
  monitor: typeof monitors.$inferSelect,
  newStatus: MonitorStatus,
  prevStatus: string,
  errorMessage: string | null,
): Promise<number[]> {
  const isDown = newStatus === 'down' || newStatus === 'degraded'
  // 'affected' = monitor failed but a dependency is already down — suppress alert (root cause fires its own)
  // Recovery from 'affected' is suppressed too, unless this monitor had alerted on its own before it
  // became affected (down → affected → up): that alert is still open and owes an all-clear.
  const isRecovery = newStatus === 'up' && (
    prevStatus === 'down' || prevStatus === 'degraded' ||
    (prevStatus === 'affected' && await hasOpenAlert(monitor.id))
  )
  if (!isDown && !isRecovery) return []

  const channels = await linkedChannels(monitor.id)

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

  const dueNow: number[] = []
  for (const channel of channels) {
    if (channel.enabled !== 1) continue
    if (isRecovery && channel.notifyOnRecovery !== 1) continue
    const deliveryId = await engine.plan(channel, vars, { sourceId: monitor.id, sourceName: monitor.name, eventType })
    if (deliveryId !== null) dueNow.push(deliveryId)
  }
  return dueNow
}

/** Records the delivery for every channel, then sends them all at once: a channel that hangs does not hold up the others. */
export async function sendNotifications(
  monitor: typeof monitors.$inferSelect,
  newStatus: MonitorStatus,
  prevStatus: string,
  errorMessage: string | null,
) {
  const dueNow = await planNotifications(monitor, newStatus, prevStatus, errorMessage)
  await Promise.all(dueNow.map((deliveryId) => engine.attemptDelivery(deliveryId)))
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

type ActionRunInfo = { actionId: number; actionName: string; monitorId: number | null; monitorName: string; onStatus: string; attemptCount: number }

/**
 * Tells the channels chosen for an action that one of its runs failed for good. The message carries the redacted
 * error of the last attempt and never the request, so no secret of the action reaches the delivery history.
 */
export const sendActionFailureNotifications = (run: ActionRunInfo, errorMessage: string) =>
  sendActionNotifications(run, 'action-failed', errorMessage)

/** Tells the channels chosen for an action that one of its runs went through; only those set to hear about successes. */
export const sendActionSuccessNotifications = (run: ActionRunInfo) => sendActionNotifications(run, 'action-succeeded', '')

async function sendActionNotifications(run: ActionRunInfo, status: 'action-failed' | 'action-succeeded', errorMessage: string): Promise<void> {
  const links = await db.select().from(actionNotificationChannels).where(eq(actionNotificationChannels.actionId, run.actionId))
  if (links.length === 0) return
  const channels = await db.select().from(notificationChannels).where(inArray(notificationChannels.id, links.map((l) => l.channelId)))
  const monitor = run.monitorId === null ? undefined : (await db.select({ type: monitors.type }).from(monitors).where(eq(monitors.id, run.monitorId)))[0]
  const vars: Record<string, string> = {
    monitor_name: run.monitorName,
    monitor_type: monitor?.type ?? 'unknown',
    status,
    previous_status: run.onStatus,
    error_message: errorMessage,
    checked_at: new Date().toISOString(),
    event_type: 'action',
    action_name: run.actionName,
    trigger_status: run.onStatus,
    attempts: String(run.attemptCount),
    monitor_list: run.monitorName,
    affected_count: '1',
  }
  for (const channel of channels) {
    if (channel.enabled !== 1) continue
    if (status === 'action-succeeded' && !hearsActionSuccesses(channel)) continue
    await dispatchToChannel(channel, vars, { monitorId: run.monitorId, monitorName: run.monitorName, eventType: 'action' })
  }
}

/** A channel is told about the runs of an action that succeeded when its config says so (the Action tab of its form). */
function hearsActionSuccesses(channel: ChannelRow): boolean {
  try {
    return (JSON.parse(channel.config) as { notifyOnActionSuccess?: unknown }).notifyOnActionSuccess === true
  } catch {
    return false
  }
}

async function linkedChannels(monitorId: number): Promise<ChannelRow[]> {
  const links = await db.select().from(monitorNotificationChannels)
    .where(eq(monitorNotificationChannels.monitorId, monitorId))
  if (links.length === 0) return []
  return db.select().from(notificationChannels)
    .where(inArray(notificationChannels.id, links.map((l) => l.channelId)))
}

/** Send a test email directly to the given address using current SMTP settings. */
export async function testSmtp(to: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await transports.sendEmail(
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

  return engine.sendDirect(channel, vars, { sourceId: null, sourceName: 'Test Monitor', eventType: 'test' })
}
