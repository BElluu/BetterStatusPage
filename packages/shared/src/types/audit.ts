import type { AuditLogEntry as BaseAuditLogEntry, KitAuditEntityType } from '@better-kit/contracts'

export type AuditEntityType =
  | KitAuditEntityType
  | 'monitor'
  | 'incident'
  | 'incident_template'
  | 'maintenance'
  | 'action'
  | 'action_run'
  | 'subscription_settings'
  | 'subscriber'
  | 'status_page_access'
  | 'branding'
  | 'layout'
  | 'locale'
  | 'subscriber_delivery'
  | 'static_mirror'

export type AuditLogEntry = BaseAuditLogEntry<AuditEntityType>
