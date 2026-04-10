import type { VaultRef } from './monitor.js'

export type NotificationChannelType = 'email' | 'webhook'

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

export type NotificationChannelConfig = EmailNotificationConfig | WebhookNotificationConfig

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
