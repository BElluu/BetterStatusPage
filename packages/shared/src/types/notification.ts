import type { NotificationChannelConfig, NotificationChannelType, NotificationDeliveryStatus, NotificationSuppressionReason, QuietHoursPolicy } from '@better-kit/contracts'

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

export interface NotificationChannel {
  id: number
  /** Technical identifier used by the API and config files; unique, set when the channel is created and never changed. */
  key: string
  name: string
  type: NotificationChannelType
  config: NotificationChannelConfig & {
    /** The channel is also told about the runs of an action that succeeded, not only about the ones that failed. */
    notifyOnActionSuccess?: boolean
  }
  enabled: number
  notifyOnRecovery: number
  alertPolicy: ChannelAlertPolicy
  createdAt: number
  updatedAt: number
}

export type NotificationEventType = 'alert' | 'recovery' | 'certificate' | 'action' | 'test'

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

/** The subject and body a new email channel starts with. */
export const DEFAULT_EMAIL_SUBJECT = 'Monitor {{monitor_name}} is {{status}}'
export const DEFAULT_EMAIL_BODY = `Monitor: {{monitor_name}}
Type:    {{monitor_type}}
Status:  {{status}}
Error:   {{error_message}}
Time:    {{checked_at}}`
