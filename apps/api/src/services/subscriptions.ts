import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { layout, monitors, subscribers, subscriptionSettings } from '../db/schema.js'
import {
  DEFAULT_SUBSCRIPTION_SETTINGS, SUBSCRIBER_EVENT_TYPES,
  type LayoutNode, type LayoutTree, type MonitorTag, type PublicSubscriptionOptions, type Subscriber,
  type SubscriberEventType, type SubscriberStatus, type SubscriberType, type SubscriptionPreferences,
  type SubscriptionPreferencesUpdate, type SubscriptionRequest, type SubscriptionSettings, type WebhookHeader, type WebhookMethod,
  MAX_WEBHOOK_HEADERS, SUBSCRIPTION_METHODS, WEBHOOK_DISABLE_AFTER_FAILURES, WEBHOOK_METHODS, subscriptionMethodStatuses,
  type SubscriptionMethod, type SubscriptionMethodStatus,
} from '@bsp/shared'
import { isSmtpConfigured, sendSmtpMail } from '../workers/notifier.js'
import { validateWebhookUrl } from './publicWebhook.js'
import { decrypt, encrypt } from '../crypto/vault.js'
import { resolvePublicUrl } from '../config/publicUrl.js'
import { loadEmailBrand, renderEmail, toneColor } from './emailTemplate.js'

const CONFIRM_TOKEN_TTL_MS = 48 * 60 * 60 * 1000
/** A destination gets at most one confirmation (or reminder) email per cooldown, however often it is submitted. */
const CONFIRMATION_COOLDOWN_MS = 10 * 60 * 1000
const MAX_EMAIL_LENGTH = 254
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/

type SettingsRow = typeof subscriptionSettings.$inferSelect
type SubscriberRow = typeof subscribers.$inferSelect

export class SubscriptionError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message)
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────

function parseJsonArray<T>(raw: string, guard: (value: unknown) => value is T): T[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(guard) : []
  } catch {
    return []
  }
}

const isEventType = (value: unknown): value is SubscriberEventType =>
  typeof value === 'string' && (SUBSCRIBER_EVENT_TYPES as string[]).includes(value)
const isPositiveInt = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

function settingsFromRow(row: SettingsRow | undefined): SubscriptionSettings {
  if (!row) return { ...DEFAULT_SUBSCRIPTION_SETTINGS, allowedEvents: [...DEFAULT_SUBSCRIPTION_SETTINGS.allowedEvents], updatedAt: 0 }
  return {
    enabled: row.enabled === 1,
    allowEmail: row.allowEmail === 1,
    allowWebhook: row.allowWebhook === 1,
    allowedEvents: parseJsonArray(row.allowedEvents, isEventType),
    allowComponentScope: row.allowComponentScope === 1,
    rssEnabled: row.rssEnabled === 1,
    allowSlack: row.allowSlack === 1,
    apiEnabled: row.apiEnabled === 1,
    updatedAt: row.updatedAt,
  }
}

export async function getSubscriptionSettings(): Promise<SubscriptionSettings> {
  return settingsFromRow((await db.select().from(subscriptionSettings))[0])
}

/** Validates an operator's settings payload; unknown event types are rejected. */
export function normalizeSubscriptionSettings(input: Partial<SubscriptionSettings>, current: SubscriptionSettings): Omit<SubscriptionSettings, 'updatedAt'> {
  let allowedEvents = current.allowedEvents
  if (input.allowedEvents !== undefined) {
    if (!Array.isArray(input.allowedEvents) || !input.allowedEvents.every(isEventType)) {
      throw new SubscriptionError(`Allowed events must be a subset of: ${SUBSCRIBER_EVENT_TYPES.join(', ')}`)
    }
    allowedEvents = SUBSCRIBER_EVENT_TYPES.filter((type) => input.allowedEvents!.includes(type))
  }
  const bool = (value: unknown, fallback: boolean) => (value === undefined ? fallback : value === true)
  return {
    enabled: bool(input.enabled, current.enabled),
    allowEmail: bool(input.allowEmail, current.allowEmail),
    allowWebhook: bool(input.allowWebhook, current.allowWebhook),
    allowedEvents,
    allowComponentScope: bool(input.allowComponentScope, current.allowComponentScope),
    rssEnabled: bool(input.rssEnabled, current.rssEnabled),
    allowSlack: bool(input.allowSlack, current.allowSlack),
    apiEnabled: bool(input.apiEnabled, current.apiEnabled),
  }
}

export async function saveSubscriptionSettings(values: Omit<SubscriptionSettings, 'updatedAt'>): Promise<SubscriptionSettings> {
  const row = {
    enabled: values.enabled ? 1 : 0,
    allowEmail: values.allowEmail ? 1 : 0,
    allowWebhook: values.allowWebhook ? 1 : 0,
    allowedEvents: JSON.stringify(values.allowedEvents),
    allowComponentScope: values.allowComponentScope ? 1 : 0,
    rssEnabled: values.rssEnabled ? 1 : 0,
    allowSlack: values.allowSlack ? 1 : 0,
    apiEnabled: values.apiEnabled ? 1 : 0,
    updatedAt: Date.now(),
  }
  await db.insert(subscriptionSettings).values({ id: 1, ...row })
    .onConflictDoUpdate({ target: subscriptionSettings.id, set: row })
  return getSubscriptionSettings()
}

export function allowedChannels(settings: SubscriptionSettings): SubscriberType[] {
  const channels: SubscriberType[] = []
  if (settings.allowEmail) channels.push('email')
  if (settings.allowWebhook) channels.push('webhook')
  return channels
}

// ── Public components ────────────────────────────────────────────────────────

export interface PublicComponent {
  id: number
  name: string
  tags: string[]
}

function collectMonitorIds(nodes: LayoutNode[], into: Set<number>): Set<number> {
  for (const node of nodes) {
    if (node.type === 'monitor') into.add(node.monitorId)
    else if (node.type === 'group') collectMonitorIds(node.children, into)
  }
  return into
}

/**
 * Only monitors placed on the published page may be offered to — or named to — subscribers.
 * Everything else is internal and must not leak through the subscribe form or emails.
 */
export async function getPublicComponents(): Promise<PublicComponent[]> {
  const layoutRow = (await db.select().from(layout))[0]
  if (!layoutRow) return []
  let ids: Set<number>
  try {
    ids = collectMonitorIds((JSON.parse(layoutRow.tree) as LayoutTree).children ?? [], new Set())
  } catch {
    return []
  }
  if (ids.size === 0) return []
  const rows = await db.select({ id: monitors.id, name: monitors.name, tags: monitors.tags }).from(monitors)
  return rows.filter((row) => ids.has(row.id)).map((row) => ({
    id: row.id,
    name: row.name,
    tags: parseJsonArray(row.tags, (tag: unknown): tag is MonitorTag => !!tag && typeof (tag as MonitorTag).label === 'string')
      .map((tag) => tag.label),
  }))
}

export async function getMethodStatuses(settings?: SubscriptionSettings): Promise<Record<SubscriptionMethod, SubscriptionMethodStatus>> {
  const current = settings ?? await getSubscriptionSettings()
  return subscriptionMethodStatuses(current, { smtpConfigured: await isSmtpConfigured(), publicUrl: resolvePublicUrl() })
}

/** Slack, feeds and the API depend on neither SMTP nor a public URL, so this needs no lookups. */
export function feedMethodAvailable(settings: SubscriptionSettings, method: 'slack' | 'rss' | 'api'): boolean {
  return subscriptionMethodStatuses(settings, { smtpConfigured: false, publicUrl: '' })[method].available
}

export async function getPublicSubscriptionOptions(): Promise<PublicSubscriptionOptions> {
  const settings = await getSubscriptionSettings()
  const statuses = await getMethodStatuses(settings)
  const components = settings.allowComponentScope ? await getPublicComponents() : []
  return {
    methods: SUBSCRIPTION_METHODS.filter((method) => statuses[method].available),
    events: settings.allowedEvents,
    allowComponentScope: settings.allowComponentScope && components.length > 0,
    components: components.map(({ id, name }) => ({ id, name })),
    tags: [...new Set(components.flatMap((component) => component.tags))].sort(),
    baseUrl: resolvePublicUrl() || null,
  }
}

export const SLACK_FEED_PATH = '/api/v1/public/slack.rss'

// ── Subscriber lifecycle ─────────────────────────────────────────────────────

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2)
  return `${visible}${'•'.repeat(Math.max(1, Math.min(6, local.length - visible.length)))}@${domain}`
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/
/** Headers the transport or the payload contract owns; a subscriber overriding them would break delivery. */
const RESERVED_HEADERS = new Set([
  'host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade',
  'te', 'trailer', 'expect', 'proxy-authorization', 'proxy-connection', 'user-agent', 'cookie',
])
const MAX_HEADER_VALUE_LENGTH = 1024

/**
 * Validates a subscriber's custom headers. An empty value keeps the saved value of the header with
 * the same name, so the manage page can edit the list without ever receiving secrets back.
 */
export function normalizeWebhookHeaders(input: unknown, saved: WebhookHeader[] = []): WebhookHeader[] {
  if (input === undefined) return saved
  if (!Array.isArray(input)) throw new SubscriptionError('Headers must be a list')
  if (input.length > MAX_WEBHOOK_HEADERS) throw new SubscriptionError(`At most ${MAX_WEBHOOK_HEADERS} headers are allowed`)
  const seen = new Set<string>()
  return input.map((raw: unknown) => {
    const header = (raw ?? {}) as Partial<WebhookHeader>
    const name = String(header.name ?? '').trim()
    const lower = name.toLowerCase()
    if (!HEADER_NAME.test(name)) throw new SubscriptionError(`"${name.slice(0, 64)}" is not a valid header name`)
    if (RESERVED_HEADERS.has(lower) || lower.startsWith('x-bsp-')) throw new SubscriptionError(`The ${name} header cannot be customized`)
    if (seen.has(lower)) throw new SubscriptionError(`The ${name} header is listed twice`)
    seen.add(lower)
    let value = String(header.value ?? '')
    if (value === '') value = saved.find((existing) => existing.name.toLowerCase() === lower)?.value ?? ''
    if (value === '') throw new SubscriptionError(`The ${name} header needs a value`)
    if (value.length > MAX_HEADER_VALUE_LENGTH || /[\r\n\0]/.test(value)) throw new SubscriptionError(`The ${name} header value is not allowed`)
    return { name, value }
  })
}

function normalizeWebhookMethod(input: unknown, fallback: WebhookMethod): WebhookMethod {
  if (input === undefined) return fallback
  if (!WEBHOOK_METHODS.includes(input as WebhookMethod)) throw new SubscriptionError(`Method must be one of: ${WEBHOOK_METHODS.join(', ')}`)
  return input as WebhookMethod
}

function encryptHeaders(headers: WebhookHeader[]): string | null {
  return headers.length ? encrypt(JSON.stringify(headers)) : null
}

export function readWebhookHeaders(row: Pick<SubscriberRow, 'webhookHeaders' | 'id'>): WebhookHeader[] {
  if (!row.webhookHeaders) return []
  try {
    return JSON.parse(decrypt(row.webhookHeaders)) as WebhookHeader[]
  } catch (error) {
    console.error(`[subscriptions] Cannot read webhook headers of subscriber ${row.id}:`, error)
    return []
  }
}

export function toSubscriber(row: SubscriberRow): Subscriber {
  const isWebhook = row.type === 'webhook'
  return {
    id: row.id,
    type: row.type as SubscriberType,
    email: row.email,
    webhookUrl: row.webhookUrl,
    webhookMethod: isWebhook ? row.webhookMethod as WebhookMethod : null,
    webhookHeaderNames: isWebhook ? readWebhookHeaders(row).map((header) => header.name) : [],
    notifyOnFailure: isWebhook && row.notifyOnFailure === 1,
    status: row.status as SubscriberStatus,
    events: parseJsonArray(row.events, isEventType),
    monitorIds: parseJsonArray(row.monitorIds, isPositiveInt),
    tags: parseJsonArray(row.tags, isNonEmptyString),
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
    unsubscribedAt: row.unsubscribedAt,
    lastNotifiedAt: row.lastNotifiedAt,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    disabledAt: row.disabledAt,
  }
}

function toPreferences(row: SubscriberRow): SubscriptionPreferences {
  const subscriber = toSubscriber(row)
  return {
    type: subscriber.type,
    email: maskEmail(subscriber.email),
    webhookUrl: subscriber.webhookUrl,
    webhookMethod: subscriber.webhookMethod,
    webhookHeaderNames: subscriber.webhookHeaderNames,
    notifyOnFailure: subscriber.notifyOnFailure,
    status: subscriber.status,
    events: subscriber.events,
    monitorIds: subscriber.monitorIds,
    tags: subscriber.tags,
  }
}

interface Scope {
  events: SubscriberEventType[]
  monitorIds: number[]
  tags: string[]
}

/** Clamps what a visitor asked for to what the operator currently allows. */
async function resolveScope(
  input: Pick<SubscriptionRequest, 'events' | 'monitorIds' | 'tags'>,
  settings: SubscriptionSettings,
): Promise<Scope> {
  const requested = input.events === undefined ? settings.allowedEvents : input.events
  if (!Array.isArray(requested)) throw new SubscriptionError('events must be an array')
  const events = settings.allowedEvents.filter((type) => requested.includes(type))
  if (events.length === 0) throw new SubscriptionError('Choose at least one notification type')

  if (!settings.allowComponentScope) return { events, monitorIds: [], tags: [] }
  const components = await getPublicComponents()
  const componentIds = new Set(components.map((component) => component.id))
  const componentTags = new Set(components.flatMap((component) => component.tags))
  const monitorIds = Array.isArray(input.monitorIds) ? [...new Set(input.monitorIds.filter(isPositiveInt))] : []
  const tags = Array.isArray(input.tags) ? [...new Set(input.tags.filter(isNonEmptyString))] : []
  if (monitorIds.some((id) => !componentIds.has(id))) throw new SubscriptionError('Unknown component')
  if (tags.some((tag) => !componentTags.has(tag))) throw new SubscriptionError('Unknown tag')
  return { events, monitorIds, tags }
}

/** One link covers changing and cancelling a subscription — the manage page does both. */
export function subscriptionLinks(publicUrl: string, manageToken: string) {
  const token = encodeURIComponent(manageToken)
  return {
    manageUrl: `${publicUrl}/#subscription=manage&token=${token}`,
    /** RFC 8058 one-click endpoint for mail clients' own unsubscribe button. */
    oneClickUrl: `${publicUrl}/api/v1/public/subscriptions/unsubscribe?token=${token}`,
  }
}

async function sendConfirmationEmail(row: SubscriberRow, confirmToken: string, publicUrl: string): Promise<void> {
  const brand = await loadEmailBrand(publicUrl)
  const confirmUrl = `${publicUrl}/#subscription=confirm&token=${encodeURIComponent(confirmToken)}`
  const what = row.type === 'webhook' ? `webhook notifications to ${row.webhookUrl}` : 'email notifications'
  await sendSmtpMail({
    to: row.email,
    subject: `Confirm your subscription to ${brand.siteName}`,
    ...renderEmail(brand, {
      preheader: `One click to start receiving status updates from ${brand.siteName}.`,
      title: 'Confirm your subscription',
      paragraphs: [`Someone — hopefully you — asked to receive ${what} about ${brand.siteName}.`],
      cta: { label: 'Confirm subscription', url: confirmUrl },
      footer: 'The link expires in 48 hours. If you did not ask for this, ignore this email and nothing will be sent.',
    }),
  })
}

async function sendAlreadySubscribedEmail(row: SubscriberRow, publicUrl: string): Promise<void> {
  const brand = await loadEmailBrand(publicUrl)
  const links = subscriptionLinks(publicUrl, row.manageToken)
  const what = row.type === 'webhook' ? `the webhook ${row.webhookUrl}` : 'this address'
  await sendSmtpMail({
    to: row.email,
    subject: `You are already subscribed to ${brand.siteName}`,
    ...renderEmail(brand, {
      preheader: 'Nothing has changed — here is your manage link.',
      title: 'You are already subscribed',
      paragraphs: [
        `Someone asked to subscribe ${what} to ${brand.siteName}, but it is already subscribed. Nothing has been changed.`,
        ...(row.status === 'disabled' ? ['It is currently paused because the endpoint kept failing — you can turn it back on from your subscription page.'] : []),
      ],
      cta: { label: 'Manage or unsubscribe', url: links.manageUrl },
      footer: `You are receiving this because this address is subscribed to status updates from ${brand.siteName}.`,
    }),
  })
}

function deliverInBackground(work: () => Promise<void>): void {
  // The response must not reveal whether a destination is already known, so mail goes out
  // after it — with the same timing for every outcome.
  setImmediate(() => { work().catch((error) => console.error('[subscriptions] Confirmation email failed:', error)) })
}

/**
 * Registers (or refreshes) a subscription and emails a confirmation link. Every outcome looks the
 * same to the caller so the form cannot be used to discover who is subscribed.
 */
export async function requestSubscription(input: SubscriptionRequest, now = Date.now()): Promise<void> {
  const settings = await getSubscriptionSettings()
  const options = await getPublicSubscriptionOptions()
  if (!options.methods.includes('email') && !options.methods.includes('webhook')) {
    throw new SubscriptionError('Subscriptions are not available', 404)
  }

  const type = input.type
  if (type !== 'email' && type !== 'webhook') throw new SubscriptionError('Unknown subscription type')
  if (!options.methods.includes(type)) throw new SubscriptionError('This subscription type is not available')

  const email = String(input.email ?? '').trim().toLowerCase()
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) throw new SubscriptionError('Enter a valid email address')

  let webhookUrl: string | null = null
  let webhookMethod: WebhookMethod = 'POST'
  let webhookHeaders: WebhookHeader[] = []
  if (type === 'webhook') {
    webhookUrl = String(input.webhookUrl ?? '').trim()
    const problem = validateWebhookUrl(webhookUrl)
    if (problem) throw new SubscriptionError(problem)
    webhookMethod = normalizeWebhookMethod(input.webhookMethod, 'POST')
    webhookHeaders = normalizeWebhookHeaders(input.webhookHeaders ?? [])
  }

  const scope = await resolveScope(input, settings)
  const publicUrl = resolvePublicUrl()
  const targetKey = type === 'email' ? `email:${email}` : `webhook:${webhookUrl}`
  const existing = (await db.select().from(subscribers).where(eq(subscribers.targetKey, targetKey)))[0]
  // The cooldown stops a stranger from flooding an inbox, but a confirmation that was followed by
  // an unsubscribe has been used up: signing up again afterwards must get a fresh link straight
  // away. The new send resets confirmationSentAt, so repeated signups are still rate-limited.
  const spentByUnsubscribe = existing?.status === 'unsubscribed'
    && (existing.unsubscribedAt ?? 0) > (existing.confirmationSentAt ?? 0)
  const cooledDown = spentByUnsubscribe
    || !existing?.confirmationSentAt
    || now - existing.confirmationSentAt >= CONFIRMATION_COOLDOWN_MS

  if (existing && (existing.status === 'active' || existing.status === 'disabled')) {
    // Never let a stranger change someone's subscription — point the owner at their manage link.
    if (!cooledDown) return
    await db.update(subscribers).set({ confirmationSentAt: now, updatedAt: now }).where(eq(subscribers.id, existing.id))
    deliverInBackground(() => sendAlreadySubscribedEmail(existing, publicUrl))
    return
  }
  if (existing && !cooledDown) return

  const confirmToken = newToken()
  const values = {
    type,
    email,
    webhookUrl,
    webhookMethod,
    webhookHeaders: encryptHeaders(webhookHeaders),
    notifyOnFailure: type === 'webhook' && input.notifyOnFailure === true ? 1 : 0,
    status: 'pending',
    events: JSON.stringify(scope.events),
    monitorIds: JSON.stringify(scope.monitorIds),
    tags: JSON.stringify(scope.tags),
    confirmTokenHash: hashToken(confirmToken),
    confirmExpiresAt: now + CONFIRM_TOKEN_TTL_MS,
    confirmationSentAt: now,
    unsubscribedAt: null,
    lastError: null,
    consecutiveFailures: 0,
    failureNotifiedAt: null,
    disabledAt: null,
    updatedAt: now,
  }
  const [row] = existing
    ? await db.update(subscribers).set(values).where(eq(subscribers.id, existing.id)).returning()
    : await db.insert(subscribers).values({ ...values, targetKey, manageToken: newToken(), createdAt: now }).returning()
  deliverInBackground(() => sendConfirmationEmail(row!, confirmToken, publicUrl))
}

const EVENT_NAMES: Record<SubscriberEventType, string> = {
  'incident.created': 'New incidents',
  'incident.updated': 'Incident updates',
  'incident.resolved': 'Resolved incidents',
  'maintenance.scheduled': 'Scheduled maintenance',
}

/** Sent once a subscription is confirmed — the one place the subscriber gets their manage link. */
async function sendSubscribedEmail(row: SubscriberRow, publicUrl: string): Promise<void> {
  const brand = await loadEmailBrand(publicUrl)
  const subscriber = toSubscriber(row)
  const links = subscriptionLinks(publicUrl, row.manageToken)
  const components = await getPublicComponents()
  const scope = [
    ...subscriber.monitorIds.map((id) => components.find((component) => component.id === id)?.name).filter((name): name is string => !!name),
    ...subscriber.tags.map((tag) => `#${tag}`),
  ]
  await sendSmtpMail({
    to: row.email,
    subject: `You are subscribed to ${brand.siteName}`,
    ...renderEmail(brand, {
      preheader: `You will now receive status updates from ${brand.siteName}.`,
      badge: { label: 'Subscribed', color: toneColor(brand, 'resolved') },
      title: 'You are subscribed',
      paragraphs: [`Thanks for confirming. From now on we will let you know when ${brand.siteName} publishes an update you asked for.`],
      details: [
        ...(row.type === 'webhook' ? [{ label: 'Webhook', value: row.webhookUrl ?? '' }] : []),
        { label: 'Notifications', value: subscriber.events.map((type) => EVENT_NAMES[type]).join(', ') },
        { label: 'Components', value: scope.length ? scope.join(', ') : 'All components' },
      ],
      cta: { label: 'Manage or unsubscribe', url: links.manageUrl },
      footer: 'Keep this email: the button above is how you change what you receive or stop the notifications at any time.',
    }),
    headers: {
      'List-Unsubscribe': `<${links.oneClickUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  })
}

/**
 * Confirms from the link in the email alone. The manage token is not returned to the page — it
 * reaches the subscriber only by email, together with the confirmation of what they signed up for.
 */
export async function confirmSubscription(token: string, now = Date.now()): Promise<{ type: SubscriberType }> {
  if (!token) throw new SubscriptionError('Invalid or expired link', 404)
  const row = (await db.select().from(subscribers).where(eq(subscribers.confirmTokenHash, hashToken(token))))[0]
  if (!row || row.status !== 'pending' || (row.confirmExpiresAt ?? 0) < now) throw new SubscriptionError('Invalid or expired link', 404)
  const [updated] = await db.update(subscribers).set({
    status: 'active', confirmedAt: now, confirmTokenHash: null, confirmExpiresAt: null, updatedAt: now,
  }).where(eq(subscribers.id, row.id)).returning()
  const publicUrl = resolvePublicUrl()
  deliverInBackground(() => sendSubscribedEmail(updated!, publicUrl))
  return { type: updated!.type as SubscriberType }
}

async function findByManageToken(token: string): Promise<SubscriberRow> {
  const row = token ? (await db.select().from(subscribers).where(eq(subscribers.manageToken, token)))[0] : undefined
  // A pending subscriber has not proven the address yet, so the manage link does nothing for it.
  if (!row || row.status === 'pending') throw new SubscriptionError('Invalid or expired link', 404)
  return row
}

export async function getSubscriptionPreferences(token: string): Promise<SubscriptionPreferences> {
  return toPreferences(await findByManageToken(token))
}

export async function updateSubscriptionPreferences(
  token: string,
  input: SubscriptionPreferencesUpdate,
  now = Date.now(),
): Promise<SubscriptionPreferences> {
  const row = await findByManageToken(token)
  const settings = await getSubscriptionSettings()
  const scope = await resolveScope(input, settings)
  const reactivate = (row.status === 'unsubscribed' || row.status === 'disabled') && input.resubscribe === true
  const webhook = row.type === 'webhook'
    ? {
        webhookMethod: normalizeWebhookMethod(input.webhookMethod, row.webhookMethod as WebhookMethod),
        webhookHeaders: encryptHeaders(normalizeWebhookHeaders(input.webhookHeaders, readWebhookHeaders(row))),
        ...(input.notifyOnFailure !== undefined ? { notifyOnFailure: input.notifyOnFailure === true ? 1 : 0 } : {}),
      }
    : {}
  const [updated] = await db.update(subscribers).set({
    events: JSON.stringify(scope.events),
    monitorIds: JSON.stringify(scope.monitorIds),
    tags: JSON.stringify(scope.tags),
    ...webhook,
    ...(reactivate
      ? { status: 'active', unsubscribedAt: null, disabledAt: null, consecutiveFailures: 0, failureNotifiedAt: null, lastError: null }
      : {}),
    updatedAt: now,
  }).where(eq(subscribers.id, row.id)).returning()
  return toPreferences(updated!)
}

export async function unsubscribe(token: string, now = Date.now()): Promise<void> {
  const row = await findByManageToken(token)
  if (row.status === 'unsubscribed') return
  await db.update(subscribers).set({ status: 'unsubscribed', unsubscribedAt: now, updatedAt: now })
    .where(eq(subscribers.id, row.id))
}

// ── Webhook health ───────────────────────────────────────────────────────────

const FAILURE_EMAIL_INTERVAL_MS = 24 * 60 * 60 * 1000

export async function recordWebhookSuccess(subscriberId: number): Promise<void> {
  await db.update(subscribers).set({ consecutiveFailures: 0, failureNotifiedAt: null })
    .where(eq(subscribers.id, subscriberId))
}

/**
 * Called once a delivery has used up all its retries. Opted-in owners hear about it by email (at
 * most daily); after WEBHOOK_DISABLE_AFTER_FAILURES failed deliveries in a row the subscription is
 * paused, so a dead or unwilling endpoint stops receiving traffic. The pause notice always goes
 * out — otherwise a subscriber could be switched off without ever knowing.
 */
export async function recordWebhookFailure(subscriberId: number, error: string, now = Date.now()): Promise<void> {
  const row = (await db.select().from(subscribers).where(eq(subscribers.id, subscriberId)))[0]
  if (!row || row.type !== 'webhook' || row.status !== 'active') return
  const failures = row.consecutiveFailures + 1
  const disable = failures >= WEBHOOK_DISABLE_AFTER_FAILURES
  const alert = !disable && row.notifyOnFailure === 1 && (!row.failureNotifiedAt || now - row.failureNotifiedAt >= FAILURE_EMAIL_INTERVAL_MS)
  await db.update(subscribers).set({
    consecutiveFailures: failures,
    ...(disable ? { status: 'disabled', disabledAt: now } : {}),
    ...(alert ? { failureNotifiedAt: now } : {}),
    updatedAt: now,
  }).where(eq(subscribers.id, row.id))
  if (!disable && !alert) return

  const publicUrl = resolvePublicUrl()
  const links = subscriptionLinks(publicUrl, row.manageToken)
  const brand = await loadEmailBrand(publicUrl)
  const footer = {
    footer: `You are receiving this because you subscribed a webhook to status updates from ${brand.siteName}.`,
  }
  const message = disable
    ? {
        subject: `[${brand.siteName}] Webhook notifications paused`,
        ...renderEmail(brand, {
          preheader: `${failures} failed deliveries in a row — notifications are paused.`,
          badge: { label: 'Paused', color: toneColor(brand, 'paused') },
          title: 'Webhook notifications paused',
          paragraphs: [
            `Your webhook ${row.webhookUrl} failed to accept ${failures} status updates in a row, so we have paused it.`,
            'Fix the endpoint, then turn notifications back on from your subscription page.',
          ],
          code: `Last error: ${error}`,
          cta: { label: 'Manage or unsubscribe', url: links.manageUrl },
          ...footer,
        }),
      }
    : {
        subject: `[${brand.siteName}] Your webhook is not accepting status updates`,
        ...renderEmail(brand, {
          preheader: 'A status update could not be delivered to your webhook.',
          badge: { label: 'Action needed', color: toneColor(brand, 'warning') },
          title: 'Your webhook is not accepting status updates',
          paragraphs: [
            `We could not deliver a status update to ${row.webhookUrl}, even after retrying.`,
            `After ${WEBHOOK_DISABLE_AFTER_FAILURES} failed updates in a row (${failures} so far) we will pause the subscription.`,
          ],
          code: `Last error: ${error}`,
          cta: { label: 'Manage or unsubscribe', url: links.manageUrl },
          ...footer,
        }),
      }
  await sendSmtpMail({ to: row.email, ...message })
    .catch((mailError) => console.error('[subscriptions] Webhook failure email failed:', mailError))
}
