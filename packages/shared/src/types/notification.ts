import type { VaultRef } from './monitor.js'

export type NotificationChannelType = 'email' | 'webhook' | 'discord' | 'teams' | 'slack'

export interface EmailNotificationConfig {
  to: string
  subject: string
  body: string
}

export interface WebhookNotificationConfig {
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH'
  headers?: Record<string, string>
  body?: string
}

export interface DiscordNotificationConfig {
  webhookUrl: string
  username?: string
  avatarUrl?: string
  content?: string
}

export interface TeamsNotificationConfig {
  webhookUrl: string
  summary?: string
}

export interface SlackNotificationConfig {
  webhookUrl: string
  text?: string
}

export type NotificationChannelConfig = EmailNotificationConfig | WebhookNotificationConfig | DiscordNotificationConfig | TeamsNotificationConfig | SlackNotificationConfig

/** Quiet hours silence a channel during a recurring local-time window. */
export interface QuietHoursPolicy {
  enabled: boolean
  /** Local start of the quiet window, `HH:MM` (24h). */
  start: string
  /** Local end of the quiet window, `HH:MM`. When <= start the window wraps past midnight. */
  end: string
  /** IANA timezone the window is expressed in, e.g. `Europe/Warsaw`. */
  timezone: string
  /** `defer` holds notifications until the window ends; `suppress` drops them. */
  mode: 'defer' | 'suppress'
}

/** Caps how many alerts a single monitor may produce on this channel per window. */
export interface ThrottlePolicy {
  enabled: boolean
  /** Maximum alerts per monitor per window. Recoveries are never throttled. */
  maxAlerts: number
  windowMinutes: number
}

/** Collapses a burst of near-simultaneous events into a single digest notification. */
export interface GroupingPolicy {
  enabled: boolean
  /** A digest is sent only when at least this many distinct monitors fire inside the window. */
  minMonitors: number
  windowSeconds: number
}

export interface ChannelAlertPolicy {
  quietHours: QuietHoursPolicy
  throttle: ThrottlePolicy
  grouping: GroupingPolicy
}

export const DEFAULT_ALERT_POLICY: ChannelAlertPolicy = {
  quietHours: { enabled: false, start: '22:00', end: '07:00', timezone: 'UTC', mode: 'defer' },
  throttle: { enabled: false, maxAlerts: 3, windowMinutes: 60 },
  grouping: { enabled: false, minMonitors: 3, windowSeconds: 60 },
}

export type NotificationSuppressionReason = 'quiet-hours' | 'throttled' | 'grouped'

export interface NotificationChannel {
  id: number
  name: string
  type: NotificationChannelType
  config: NotificationChannelConfig
  enabled: number
  notifyOnRecovery: number
  alertPolicy: ChannelAlertPolicy
  createdAt: number
  updatedAt: number
}

export interface SmtpSettings {
  host: string
  port: number
  secure: number
  user: string
  password: string
  fromAddress: string
  fromName: string
  vault?: VaultRef | null
  updatedAt: number
}

export type NotificationDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'suppressed'
export type NotificationEventType = 'alert' | 'recovery' | 'test'

export interface NotificationDelivery {
  id: number
  channelId: number
  channelName: string
  channelType: NotificationChannelType
  monitorId: number | null
  monitorName: string
  eventType: NotificationEventType
  status: NotificationDeliveryStatus
  targetStatus: string
  previousStatus: string
  attemptCount: number
  maxAttempts: number
  nextAttemptAt: number | null
  lastAttemptAt: number | null
  deliveredAt: number | null
  lastError: string | null
  /** Set when alert hygiene dropped this notification instead of sending it. */
  suppressionReason: NotificationSuppressionReason | null
  /** Identifies the digest window this delivery belongs to, when grouping is on. */
  groupKey: string | null
  createdAt: number
  updatedAt: number
}

export interface NotificationDeliveryAttempt {
  id: number
  deliveryId: number
  attemptNumber: number
  status: 'delivered' | 'failed'
  error: string | null
  startedAt: number
  completedAt: number
}
