import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'
import { randomEntityKey } from '../../../lib/entityKey.js'

export const notificationChannels = sqliteTable('notification_channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'email' | 'webhook'
  config: text('config').notNull().default('{}'), // JSON
  enabled: integer('enabled').notNull().default(1),
  notifyOnRecovery: integer('notify_on_recovery').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  // Additive columns (added via ALTER TABLE, must stay at end for sqlite-proxy position mapping)
  alertPolicy: text('alert_policy').notNull().default('{}'), // JSON ChannelAlertPolicy
  /** Stable identifier for config-as-code and API clients; unlike `id` it survives export/import. */
  key: text('key').notNull().unique().$defaultFn(randomEntityKey),
})

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

export const notificationDeliveryAttempts = sqliteTable('notification_delivery_attempts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  deliveryId: integer('delivery_id').notNull(),
  attemptNumber: integer('attempt_number').notNull(),
  status: text('status').notNull(),
  error: text('error'),
  startedAt: integer('started_at').notNull(),
  completedAt: integer('completed_at').notNull(),
})

export const smtpSettings = sqliteTable('smtp_settings', {
  id: integer('id').primaryKey(),
  host: text('host').notNull().default(''),
  port: integer('port').notNull().default(587),
  secure: integer('secure').notNull().default(0),
  user: text('user').notNull().default(''),
  password: text('password').notNull().default(''),
  fromAddress: text('from_address').notNull().default(''),
  fromName: text('from_name').notNull().default('BSP Alerts'),
  updatedAt: integer('updated_at').notNull(),
  // Additive columns (added via ALTER TABLE, must stay at end for sqlite-proxy position mapping)
  vaultConfig: text('vault_config'), // JSON VaultRef | null
})
