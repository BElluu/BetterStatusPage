/** `allow` records a successful sign-in; `deny` a refused action, such as a sign-in with a wrong password. */
export type AuditAction = 'create' | 'update' | 'delete' | 'allow' | 'deny'

/** The kinds of object the shared modules write to the audit log; an app adds its own. */
export type KitAuditEntityType =
  | 'notification_channel'
  | 'smtp_settings'
  | 'vault'
  | 'vault_secret'
  | 'user'
  | 'api_token'
  | 'oidc_settings'
  /** Security changes on a user account: password, two-factor, SSO link. */
  | 'user-security'
  /** A configuration import; the entities it changed have entries of their own. */
  | 'config'
  | 'backup'
  | 'backup-config'
  | 'notification_delivery'
  /** Every sign-in attempt, with a password or SSO; `diff.method` says which. */
  | 'sign_in'

export interface AuditLogEntry<EntityType extends string = string> {
  id: number
  userId: number
  userEmail: string
  action: AuditAction
  entityType: EntityType
  entityId: string | null
  entityName: string
  diff: Record<string, unknown> | null
  timestamp: number
}
