/** How a status page subscriber receives notifications. Every subscriber confirms by email. */
export type SubscriberType = 'email' | 'webhook'

/** `disabled`: a webhook that kept failing was switched off; its owner can turn it back on. */
export type SubscriberStatus = 'pending' | 'active' | 'unsubscribed' | 'disabled'

export type WebhookMethod = 'POST' | 'PUT' | 'PATCH'
export const WEBHOOK_METHODS: WebhookMethod[] = ['POST', 'PUT', 'PATCH']
export const MAX_WEBHOOK_HEADERS = 10
/** Consecutive failed webhook deliveries (each after all retries) before the subscription is disabled. */
export const WEBHOOK_DISABLE_AFTER_FAILURES = 5

export interface WebhookHeader {
  name: string
  value: string
}

/** Events a status page audience can subscribe to. Monitor flaps are deliberately not among them. */
export type SubscriberEventType =
  | 'incident.created'
  | 'incident.updated'
  | 'incident.resolved'
  | 'maintenance.scheduled'

export const SUBSCRIBER_EVENT_TYPES: SubscriberEventType[] = [
  'incident.created',
  'incident.updated',
  'incident.resolved',
  'maintenance.scheduled',
]

/** What the status page audience is allowed to subscribe to, set by operators. */
export interface SubscriptionSettings {
  /** Master switch for every subscription method, feeds and the status API included. */
  enabled: boolean
  allowEmail: boolean
  /** Webhook subscribers make the server call URLs supplied by anonymous visitors. */
  allowWebhook: boolean
  /** Event types subscribers may choose from. Anything else is never sent to them. */
  allowedEvents: SubscriberEventType[]
  /** Lets subscribers narrow notifications to specific public components or tags. */
  allowComponentScope: boolean
  /** Publishes the RSS and Atom incident feeds. */
  rssEnabled: boolean
  /** Offers Slack's `/feed subscribe` command, backed by a per-event feed. */
  allowSlack: boolean
  /** Publishes the read-only JSON status API (summary.json, components.json). */
  apiEnabled: boolean
  updatedAt: number
}

export const DEFAULT_SUBSCRIPTION_SETTINGS: Omit<SubscriptionSettings, 'updatedAt'> = {
  enabled: false,
  allowEmail: true,
  allowWebhook: false,
  allowedEvents: [...SUBSCRIBER_EVENT_TYPES],
  allowComponentScope: true,
  rssEnabled: true,
  allowSlack: true,
  apiEnabled: true,
}

/** Every way a visitor can follow the status page, in the order the subscribe dialog offers them. */
export type SubscriptionMethod = 'email' | 'webhook' | 'slack' | 'rss' | 'api'
export const SUBSCRIPTION_METHODS: SubscriptionMethod[] = ['email', 'webhook', 'slack', 'rss', 'api']

export type SubscriptionMethodProblem = 'disabled' | 'smtp' | 'publicUrl' | 'events'

export interface SubscriptionMethodStatus {
  /** The method's own switch. */
  enabled: boolean
  /** Offered to visitors: switched on, and nothing it depends on is missing. */
  available: boolean
  /** Why an enabled method is not offered. Empty when available or switched off. */
  problems: SubscriptionMethodProblem[]
}

/**
 * The single rule for which methods visitors are offered, shared by the API and the admin console
 * so the admin can show — before saving — exactly why a method would stay hidden.
 */
export function subscriptionMethodStatuses(
  settings: Omit<SubscriptionSettings, 'updatedAt'>,
  environment: { smtpConfigured: boolean; publicUrl: string },
): Record<SubscriptionMethod, SubscriptionMethodStatus> {
  const toggles: Record<SubscriptionMethod, boolean> = {
    email: settings.allowEmail,
    webhook: settings.allowWebhook,
    slack: settings.allowSlack,
    rss: settings.rssEnabled,
    api: settings.apiEnabled,
  }
  const needs = (method: SubscriptionMethod): SubscriptionMethodProblem[] => {
    const problems: SubscriptionMethodProblem[] = []
    if (!settings.enabled) problems.push('disabled')
    // Email and webhook subscribers confirm by email, and every email links back to the page.
    if (method === 'email' || method === 'webhook') {
      if (!environment.smtpConfigured) problems.push('smtp')
      if (!environment.publicUrl) problems.push('publicUrl')
    }
    // These three deliver notifications; feeds and the API only mirror the public page.
    if ((method === 'email' || method === 'webhook' || method === 'slack') && settings.allowedEvents.length === 0) problems.push('events')
    return problems
  }
  return Object.fromEntries(SUBSCRIPTION_METHODS.map((method) => {
    const problems = toggles[method] ? needs(method) : []
    return [method, { enabled: toggles[method], available: toggles[method] && problems.length === 0, problems }]
  })) as Record<SubscriptionMethod, SubscriptionMethodStatus>
}

/** Settings as the admin console sees them, with the reasons subscriptions cannot work yet. */
export interface AdminSubscriptionSettings extends SubscriptionSettings {
  smtpConfigured: boolean
  /** From the PUBLIC_URL environment variable — deployment configuration, not editable here. Empty when unset. */
  publicUrl: string
  methods: Record<SubscriptionMethod, SubscriptionMethodStatus>
}

export interface SubscriptionComponent {
  id: number
  name: string
}

/** What the public subscribe form may offer, derived from settings and the published layout. */
export interface PublicSubscriptionOptions {
  /** Methods visitors may choose from; empty hides the Subscribe button. */
  methods: SubscriptionMethod[]
  events: SubscriberEventType[]
  allowComponentScope: boolean
  components: SubscriptionComponent[]
  tags: string[]
  /** PUBLIC_URL, which every link shown to visitors is built from; null means "use this page's origin". */
  baseUrl: string | null
}

export interface SubscriptionRequest {
  type: SubscriberType
  /** Delivery address for email subscribers; confirmation and failure-alert address for webhooks. */
  email: string
  webhookUrl?: string
  webhookMethod?: WebhookMethod
  webhookHeaders?: WebhookHeader[]
  /** Webhooks only: email the subscriber when their endpoint stops accepting deliveries. */
  notifyOnFailure?: boolean
  events?: SubscriberEventType[]
  monitorIds?: number[]
  tags?: string[]
  /** Honeypot — real browsers leave it empty. */
  website?: string
}

/** A subscriber's own view of their subscription, reachable only with their manage token. */
export interface SubscriptionPreferences {
  type: SubscriberType
  /** Partially masked, so a leaked link does not reveal the full address. */
  email: string
  webhookUrl: string | null
  webhookMethod: WebhookMethod | null
  /** Header values are secrets and never leave the server once saved. */
  webhookHeaderNames: string[]
  notifyOnFailure: boolean
  status: SubscriberStatus
  events: SubscriberEventType[]
  monitorIds: number[]
  tags: string[]
}

export interface SubscriptionPreferencesUpdate {
  events?: SubscriberEventType[]
  monitorIds?: number[]
  tags?: string[]
  /** Re-activates an unsubscribed or disabled subscription. */
  resubscribe?: boolean
  notifyOnFailure?: boolean
  webhookMethod?: WebhookMethod
  /** Replaces the header list. An empty value keeps the saved value of a header with that name. */
  webhookHeaders?: WebhookHeader[]
}

export interface Subscriber {
  id: number
  type: SubscriberType
  email: string
  webhookUrl: string | null
  webhookMethod: WebhookMethod | null
  webhookHeaderNames: string[]
  notifyOnFailure: boolean
  status: SubscriberStatus
  events: SubscriberEventType[]
  monitorIds: number[]
  tags: string[]
  createdAt: number
  confirmedAt: number | null
  unsubscribedAt: number | null
  lastNotifiedAt: number | null
  lastError: string | null
  consecutiveFailures: number
  disabledAt: number | null
}

export interface SubscriberStats {
  total: number
  active: number
  pending: number
  unsubscribed: number
  disabled: number
}

export interface SubscriberList {
  subscribers: Subscriber[]
  stats: SubscriberStats
  total: number
  page: number
  limit: number
  pages: number
}
