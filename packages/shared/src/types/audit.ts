/** `deny` records a refused action, such as an SSO sign-in that matched no usable account. */
export type AuditAction = 'create' | 'update' | 'delete' | 'deny'

export type AuditEntityType =
  | 'monitor'
  | 'incident'
  | 'maintenance'
  | 'notification_channel'
  | 'smtp_settings'
  | 'subscription_settings'
  | 'subscriber'
  | 'vault'
  | 'vault_secret'
  | 'user'
  | 'oidc_settings'
  | 'oidc_login'

export interface AuditLogEntry {
  id: number
  userId: number
  userEmail: string
  action: AuditAction
  entityType: AuditEntityType
  entityId: string | null
  entityName: string
  diff: Record<string, unknown> | null
  timestamp: number
}
