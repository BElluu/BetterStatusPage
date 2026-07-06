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

export interface NotificationChannel {
  id: number
  name: string
  type: NotificationChannelType
  config: NotificationChannelConfig
  enabled: number
  notifyOnRecovery: number
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

export type NotificationDeliveryStatus = 'pending' | 'delivered' | 'failed'
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
