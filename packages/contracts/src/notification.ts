import type { VaultRef } from './vault.js'

export type NotificationChannelType = 'email' | 'webhook' | 'discord' | 'teams' | 'slack' | 'telegram' | 'ntfy' | 'pushover'

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

export interface TelegramNotificationConfig {
  /** Direct token; the API only ever returns it masked. Ignored when `vault` is set. */
  botToken?: string
  /** Vault secret holding the token: a `value` secret. */
  vault?: VaultRef
  chatId: string
  text?: string
}

export interface NtfyNotificationConfig {
  /** Server root; ntfy.sh when omitted. */
  serverUrl?: string
  topic: string
  /** Access token of a protected topic; the API only ever returns it masked. Ignored when `vault` is set. */
  accessToken?: string
  /** Vault secret holding the access token: a `value` secret. */
  vault?: VaultRef
  text?: string
}

export interface PushoverNotificationConfig {
  /** Application token; the API only ever returns it masked. Ignored when `vault` is set. */
  appToken?: string
  /** Vault secret holding the application token: a `value` secret. */
  vault?: VaultRef
  /** User or group key that receives the messages. */
  userKey: string
  text?: string
}

export type NotificationChannelConfig = EmailNotificationConfig | WebhookNotificationConfig | DiscordNotificationConfig | TeamsNotificationConfig | SlackNotificationConfig | TelegramNotificationConfig | NtfyNotificationConfig | PushoverNotificationConfig

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

export type NotificationSuppressionReason = 'quiet-hours' | 'throttled' | 'grouped'


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

export interface NotificationDeliveryAttempt {
  id: number
  deliveryId: number
  attemptNumber: number
  status: 'delivered' | 'failed'
  error: string | null
  startedAt: number
  completedAt: number
}
