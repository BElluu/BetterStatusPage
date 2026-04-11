export type AuditAction = 'create' | 'update' | 'delete'

export type AuditEntityType =
  | 'monitor'
  | 'incident'
  | 'maintenance'
  | 'notification_channel'
  | 'smtp_settings'
  | 'vault'
  | 'vault_secret'
  | 'user'

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
