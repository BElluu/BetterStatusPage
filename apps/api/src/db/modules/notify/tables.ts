import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

// The delivery table as the application has always named its columns (the notify package calls them sourceId and
// sourceName). Same table, same column order; kept so code and tests that read `monitorId` do not change.
export const notificationDeliveries = sqliteTable('notification_deliveries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channelId: integer('channel_id').notNull(),
  channelName: text('channel_name').notNull(),
  channelType: text('channel_type').notNull(),
  monitorId: integer('monitor_id'),
  monitorName: text('monitor_name').notNull(),
  eventType: text('event_type').notNull(),
  status: text('status').notNull().default('pending'),
  targetStatus: text('target_status').notNull(),
  previousStatus: text('previous_status').notNull(),
  variables: text('variables').notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  nextAttemptAt: integer('next_attempt_at'),
  lastAttemptAt: integer('last_attempt_at'),
  deliveredAt: integer('delivered_at'),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  // Additive columns (added via ALTER TABLE, must stay at end for sqlite-proxy position mapping)
  suppressionReason: text('suppression_reason'),
  groupKey: text('group_key'),
})
