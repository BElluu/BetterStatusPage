/** `allow` records a successful sign-in; `deny` a refused action, such as a sign-in with a wrong password. */
export type AuditAction = 'create' | 'update' | 'delete' | 'allow' | 'deny'

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
  | 'api_token'
  | 'oidc_settings'
  | 'status_page_access'
  /** Security changes on a user account: password, two-factor, SSO link. */
  | 'user-security'
  | 'branding'
  | 'layout'
  | 'locale'
  | 'backup'
  | 'backup-config'
  | 'notification_delivery'
  | 'subscriber_delivery'
  /** Every sign-in attempt, with a password or SSO; `diff.method` says which. */
  | 'sign_in'

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
