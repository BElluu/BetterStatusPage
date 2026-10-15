import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  userEmail: text('user_email').notNull(),
  action: text('action').notNull(),       // 'create' | 'update' | 'delete'
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  entityName: text('entity_name').notNull(),
  diff: text('diff'),                     // JSON | null
  timestamp: integer('timestamp').notNull(),
})
