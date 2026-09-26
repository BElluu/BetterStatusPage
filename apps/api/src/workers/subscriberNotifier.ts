import { and, desc, eq, inArray, lt, lte } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  incidentMonitors, incidentUpdates, incidents, maintenanceWindowMonitors, maintenanceWindows, monitors,
  subscriberDeliveries, subscribers,
} from '../db/schema.js'
import type { MonitorTag, SubscriberEventType, SubscriptionComponent, WebhookMethod } from '@bsp/shared'
import { sendSmtpMail } from './notifier.js'
import { postSubscriberWebhook } from '../services/publicWebhook.js'
import { resolvePublicUrl } from '../config/publicUrl.js'
import { loadEmailBrand, renderEmail, toneColor, type EmailBrand, type EmailContent, type StatusTone } from '../services/emailTemplate.js'
import {
  allowedChannels, getPublicComponents, getSubscriptionSettings, readWebhookHeaders,
  recordWebhookFailure, recordWebhookSuccess, subscriptionLinks, toSubscriber,
} from '../services/subscriptions.js'

/** Everything a subscriber message is rendered from. Only publicly visible names are included. */
export interface SubscriberEvent {
  type: SubscriberEventType
  occurredAt: number
  incident?: {
    id: number
    title: string
    status: string
    impact: string
    startedAt: number
    resolvedAt: number | null
    /** Every update posted so far, newest first. */
    updates: IncidentUpdateSummary[]
  }
  /** The update that triggered this event, when there is one. */
  update?: IncidentUpdateSummary
  maintenance?: {
    id: number
    name: string
    description: string | null
    startsAt: number
    endsAt: number
  }
  /** Public components affected. Empty means the event is not tied to specific components. */
  components: SubscriptionComponent[]
}

interface IncidentUpdateSummary {
  body: string
  status: string
  postedAt: number
}

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000]
const MAX_ATTEMPTS = 4
const SEND_CONCURRENCY = 5
const BATCH_SIZE = 200

// ── Fan-out ──────────────────────────────────────────────────────────────────

async function monitorTagMap(monitorIds: number[]): Promise<Set<string>> {
  if (monitorIds.length === 0) return new Set()
  const rows = await db.select({ tags: monitors.tags }).from(monitors).where(inArray(monitors.id, monitorIds))
  const tags = new Set<string>()
  for (const row of rows) {
    try {
      for (const tag of JSON.parse(row.tags) as MonitorTag[]) if (tag?.label) tags.add(tag.label)
    } catch { /* ignore malformed tags */ }
  }
  return tags
}

/**
 * Queues one delivery per matching active subscriber. An event linked to no monitors is
 * treated as page-wide and reaches everyone who opted into its type.
 */
export async function notifySubscribers(event: SubscriberEvent, monitorIds: number[], now = Date.now()): Promise<number> {
  const settings = await getSubscriptionSettings()
  if (!settings.enabled || !settings.allowedEvents.includes(event.type)) return 0
  const channels = allowedChannels(settings)
  if (channels.length === 0) return 0

  const eventTags = await monitorTagMap(monitorIds)
  const active = (await db.select().from(subscribers).where(eq(subscribers.status, 'active'))).map(toSubscriber)
  const recipients = active.filter((subscriber) => {
    if (!channels.includes(subscriber.type) || !subscriber.events.includes(event.type)) return false
    const scoped = settings.allowComponentScope && (subscriber.monitorIds.length > 0 || subscriber.tags.length > 0)
    if (!scoped || monitorIds.length === 0) return true
    return subscriber.monitorIds.some((id) => monitorIds.includes(id)) || subscriber.tags.some((tag) => eventTags.has(tag))
  })
  if (recipients.length === 0) return 0

  const payload = JSON.stringify(event)
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    await db.insert(subscriberDeliveries).values(recipients.slice(i, i + BATCH_SIZE).map((subscriber) => ({
      subscriberId: subscriber.id,
      eventType: event.type,
      event: payload,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: MAX_ATTEMPTS,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    })))
  }
  kickSubscriberDeliveries()
  return recipients.length
}

async function publicComponentsFor(monitorIds: number[]): Promise<SubscriptionComponent[]> {
  if (monitorIds.length === 0) return []
  const components = await getPublicComponents()
  return components.filter((component) => monitorIds.includes(component.id)).map(({ id, name }) => ({ id, name }))
}

/** Builds and queues an incident event from the stored incident, so callers only pass ids. */
export async function notifyIncidentSubscribers(
  type: Extract<SubscriberEventType, `incident.${string}`>,
  incidentId: number,
  update?: IncidentUpdateSummary,
): Promise<number> {
  const incident = (await db.select().from(incidents).where(eq(incidents.id, incidentId)))[0]
  if (!incident) return 0
  const monitorIds = (await db.select().from(incidentMonitors).where(eq(incidentMonitors.incidentId, incidentId)))
    .map((link) => link.monitorId)
  const updates = (await db.select().from(incidentUpdates).where(eq(incidentUpdates.incidentId, incidentId)).orderBy(desc(incidentUpdates.postedAt)))
    .map(({ body, status, postedAt }) => ({ body, status, postedAt }))
  return notifySubscribers({
    type,
    occurredAt: update?.postedAt ?? Date.now(),
    incident: {
      id: incident.id, title: incident.title, status: incident.status, impact: incident.impact,
      startedAt: incident.startedAt, resolvedAt: incident.resolvedAt, updates,
    },
    ...(update ? { update } : {}),
    components: await publicComponentsFor(monitorIds),
  }, monitorIds)
}

export async function notifyMaintenanceSubscribers(windowId: number): Promise<number> {
  const win = (await db.select().from(maintenanceWindows).where(eq(maintenanceWindows.id, windowId)))[0]
  if (!win) return 0
  const monitorIds = (await db.select().from(maintenanceWindowMonitors).where(eq(maintenanceWindowMonitors.windowId, windowId)))
    .map((link) => link.monitorId)
  return notifySubscribers({
    type: 'maintenance.scheduled',
    occurredAt: Date.now(),
    maintenance: { id: win.id, name: win.name, description: win.description, startsAt: win.startsAt, endsAt: win.endsAt },
    components: await publicComponentsFor(monitorIds),
  }, monitorIds)
}

// ── Rendering ────────────────────────────────────────────────────────────────

const EVENT_LABELS: Record<SubscriberEventType, string> = {
  'incident.created': 'New incident',
  'incident.updated': 'Incident update',
  'incident.resolved': 'Incident resolved',
  'maintenance.scheduled': 'Scheduled maintenance',
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function utc(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

const INCIDENT_TONES: Record<string, StatusTone> = {
  investigating: 'investigating', identified: 'identified', monitoring: 'monitoring', resolved: 'resolved',
}

export function renderSubscriberEmail(event: SubscriberEvent, brand: EmailBrand, publicUrl: string, manageToken: string) {
  const links = subscriptionLinks(publicUrl, manageToken)
  const site = brand.siteName
  const affected = event.components.length ? [{ label: 'Affected', value: event.components.map((c) => c.name).join(', ') }] : []
  const footer = {
    footer: `You are receiving this because you subscribed to status updates from ${site}.`,
    footerLink: { label: 'Manage or unsubscribe', url: links.manageUrl },
  }
  let subject: string
  let content: EmailContent
  if (event.incident) {
    const statusKey = event.update?.status ?? event.incident.status
    const status = capitalize(statusKey)
    subject = `[${site}] ${EVENT_LABELS[event.type]}: ${event.incident.title} — ${status}`
    content = {
      preheader: event.update?.body || `${EVENT_LABELS[event.type]} · ${status}`,
      badge: { label: status, color: toneColor(brand, INCIDENT_TONES[statusKey] ?? 'investigating') },
      title: event.incident.title,
      details: [
        { label: 'Status', value: status },
        { label: 'Impact', value: capitalize(event.incident.impact) },
        ...affected,
        { label: 'Posted', value: utc(event.occurredAt) },
      ],
      ...(event.update?.body ? { quote: event.update.body } : {}),
      cta: { label: 'View status page', url: brand.pageUrl },
      ...footer,
    }
  } else {
    const win = event.maintenance!
    subject = `[${site}] ${EVENT_LABELS[event.type]}: ${win.name}`
    content = {
      preheader: `${utc(win.startsAt)} → ${utc(win.endsAt)}`,
      badge: { label: 'Scheduled maintenance', color: toneColor(brand, 'maintenance') },
      title: win.name,
      details: [
        { label: 'Starts', value: utc(win.startsAt) },
        { label: 'Ends', value: utc(win.endsAt) },
        ...affected,
      ],
      ...(win.description ? { quote: win.description } : {}),
      cta: { label: 'View status page', url: brand.pageUrl },
      ...footer,
    }
  }
  return {
    subject,
    ...renderEmail(brand, content),
    headers: {
      'List-Unsubscribe': `<${links.oneClickUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())
const isoUpdate = (update: IncidentUpdateSummary) => ({ body: update.body, status: update.status, postedAt: iso(update.postedAt) })

/** Documented in docs/subscriptions.md — keep the two in step. Timestamps are ISO 8601 strings. */
export function renderSubscriberWebhook(event: SubscriberEvent, site: string, publicUrl: string, manageToken: string): string {
  const links = subscriptionLinks(publicUrl, manageToken)
  const pageUrl = `${publicUrl}/`
  return JSON.stringify({
    event: event.type,
    occurredAt: iso(event.occurredAt),
    // One link for both changing and cancelling the subscription — the manage page does both.
    meta: { manageUrl: links.manageUrl },
    page: { name: site, url: pageUrl },
    ...(event.incident ? {
      incident: {
        id: event.incident.id,
        title: event.incident.title,
        status: event.incident.status,
        impact: event.incident.impact,
        startedAt: iso(event.incident.startedAt),
        resolvedAt: iso(event.incident.resolvedAt),
        url: pageUrl,
        updates: event.incident.updates.map(isoUpdate),
      },
    } : {}),
    ...(event.update ? { update: isoUpdate(event.update) } : {}),
    ...(event.maintenance ? {
      maintenance: {
        id: event.maintenance.id,
        name: event.maintenance.name,
        description: event.maintenance.description,
        startsAt: iso(event.maintenance.startsAt),
        endsAt: iso(event.maintenance.endsAt),
        url: pageUrl,
      },
    } : {}),
    components: event.components,
  })
}

// ── Delivery ─────────────────────────────────────────────────────────────────

type DeliveryRow = typeof subscriberDeliveries.$inferSelect

async function attemptDelivery(delivery: DeliveryRow, context: { brand: EmailBrand; publicUrl: string; now: number }): Promise<void> {
  const subscriber = (await db.select().from(subscribers).where(eq(subscribers.id, delivery.subscriberId)))[0]
  const settings = await getSubscriptionSettings()
  if (!subscriber || subscriber.status !== 'active' || !settings.enabled || !allowedChannels(settings).includes(subscriber.type as 'email' | 'webhook')) {
    await db.update(subscriberDeliveries).set({ status: 'cancelled', nextAttemptAt: null, updatedAt: Date.now() })
      .where(eq(subscriberDeliveries.id, delivery.id))
    return
  }

  const attemptNumber = delivery.attemptCount + 1
  try {
    if (!context.publicUrl) throw new Error('Public URL is not configured')
    const event = JSON.parse(delivery.event) as SubscriberEvent
    if (subscriber.type === 'webhook') {
      const custom = Object.fromEntries(readWebhookHeaders(subscriber).map((header) => [header.name, header.value]))
      await postSubscriberWebhook(
        subscriber.webhookUrl ?? '',
        renderSubscriberWebhook(event, context.brand.siteName, context.publicUrl, subscriber.manageToken),
        { ...custom, 'X-BSP-Event': event.type },
        subscriber.webhookMethod as WebhookMethod,
      )
    } else {
      await sendSmtpMail({ to: subscriber.email, ...renderSubscriberEmail(event, context.brand, context.publicUrl, subscriber.manageToken) })
    }
    const completedAt = Date.now()
    await db.update(subscriberDeliveries).set({
      status: 'delivered', attemptCount: attemptNumber, nextAttemptAt: null, deliveredAt: completedAt, lastError: null, updatedAt: completedAt,
    }).where(eq(subscriberDeliveries.id, delivery.id))
    await db.update(subscribers).set({ lastNotifiedAt: completedAt, lastError: null }).where(eq(subscribers.id, subscriber.id))
    if (subscriber.type === 'webhook' && subscriber.consecutiveFailures > 0) await recordWebhookSuccess(subscriber.id)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const exhausted = attemptNumber >= delivery.maxAttempts
    const delay = RETRY_DELAYS_MS[Math.min(attemptNumber - 1, RETRY_DELAYS_MS.length - 1)]!
    const completedAt = Date.now()
    await db.update(subscriberDeliveries).set({
      status: exhausted ? 'failed' : 'pending', attemptCount: attemptNumber,
      nextAttemptAt: exhausted ? null : context.now + delay, lastError: message, updatedAt: completedAt,
    }).where(eq(subscriberDeliveries.id, delivery.id))
    await db.update(subscribers).set({ lastError: message }).where(eq(subscribers.id, subscriber.id))
    if (exhausted && subscriber.type === 'webhook') await recordWebhookFailure(subscriber.id, message)
    console.error(`[subscriptions] Delivery ${delivery.id}, attempt ${attemptNumber} failed: ${message}`)
  }
}

let processing: Promise<number> | null = null
let rerunRequested = false

/**
 * Sends due subscriber deliveries with bounded concurrency so a large audience does not open
 * hundreds of SMTP connections at once. Overlapping calls coalesce into a single pass.
 */
export function processDueSubscriberDeliveries(now = Date.now()): Promise<number> {
  if (processing) {
    rerunRequested = true
    return processing
  }
  processing = (async () => {
    let total = 0
    try {
      do {
        rerunRequested = false
        const passNow = Math.max(now, Date.now())
        const due = await db.select().from(subscriberDeliveries).where(and(
          eq(subscriberDeliveries.status, 'pending'),
          lte(subscriberDeliveries.nextAttemptAt, passNow),
        )).limit(BATCH_SIZE)
        if (due.length === 0) break
        const publicUrl = resolvePublicUrl()
        const context = { brand: await loadEmailBrand(publicUrl), publicUrl, now: passNow }
        const queue = [...due]
        await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, queue.length) }, async () => {
          for (let next = queue.shift(); next; next = queue.shift()) await attemptDelivery(next, context)
        }))
        total += due.length
        // A full batch means more may be waiting; anything retried was pushed into the future.
        if (due.length === BATCH_SIZE) rerunRequested = true
      } while (rerunRequested)
    } finally {
      processing = null
    }
    return total
  })()
  return processing
}

function kickSubscriberDeliveries(): void {
  setImmediate(() => {
    processDueSubscriberDeliveries().catch((error) => console.error('[subscriptions] Delivery pass failed:', error))
  })
}

/** Drops delivery history after 90 days and never-confirmed subscribers once their link is long dead. */
export async function purgeSubscriberData(now = Date.now()): Promise<void> {
  await db.delete(subscriberDeliveries).where(lt(subscriberDeliveries.createdAt, now - 90 * 24 * 60 * 60 * 1000))
  await db.delete(subscribers).where(and(
    eq(subscribers.status, 'pending'),
    lt(subscribers.confirmExpiresAt, now - 7 * 24 * 60 * 60 * 1000),
  ))
}
