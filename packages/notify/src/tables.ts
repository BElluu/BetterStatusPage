import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'
import { sealedText, type SealedText } from '@better-forge/vault'

/**
 * How the application names what the notification tables store about it. The tables of an existing installation keep
 * the column names they were created with, so the names are passed in instead of being fixed here.
 */
export interface NotifyTableOptions {
  /** Column of a delivery that holds the id of the thing the notification is about (it may be empty). */
  sourceIdColumn: string
  /** Column of a delivery that holds the name of that thing. */
  sourceNameColumn: string
  /** Default sender name of the SMTP settings. */
  smtpFromName: string
  /** Creates the stable `key` of a channel that is inserted without one. */
  newKey: () => string
  /**
   * The text columns that hold credentials: a channel's configuration (JSON) and the SMTP password. Build them with
   * `sealedText` from the codecs that encrypt the secrets; without them the values are stored as they are.
   */
  sealed?: { channelConfig: SealedText; smtpPassword: SealedText }
}

const plain = sealedText({ seal: (value) => value, open: (value) => value })

export function defineNotifyTables(options: NotifyTableOptions) {
  const sealed = options.sealed ?? { channelConfig: plain, smtpPassword: plain }

  const notificationChannels = sqliteTable('notification_channels', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    type: text('type').notNull(), // 'email' | 'webhook'
    config: sealed.channelConfig('config').notNull().default('{}'), // JSON
    enabled: integer('enabled').notNull().default(1),
    notifyOnRecovery: integer('notify_on_recovery').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    // Additive columns (added via ALTER TABLE, must stay at end for sqlite-proxy position mapping)
    alertPolicy: text('alert_policy').notNull().default('{}'), // JSON alert policy
    /** Stable identifier for config-as-code and API clients; unlike `id` it survives export/import. */
    key: text('key').notNull().unique().$defaultFn(options.newKey),
  })

  const notificationDeliveries = sqliteTable('notification_deliveries', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channelId: integer('channel_id').notNull(),
    channelName: text('channel_name').notNull(),
    channelType: text('channel_type').notNull(),
    sourceId: integer(options.sourceIdColumn),
    sourceName: text(options.sourceNameColumn).notNull(),
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

  const notificationDeliveryAttempts = sqliteTable('notification_delivery_attempts', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deliveryId: integer('delivery_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    status: text('status').notNull(),
    error: text('error'),
    startedAt: integer('started_at').notNull(),
    completedAt: integer('completed_at').notNull(),
  })

  const smtpSettings = sqliteTable('smtp_settings', {
    id: integer('id').primaryKey(),
    host: text('host').notNull().default(''),
    port: integer('port').notNull().default(587),
    secure: integer('secure').notNull().default(0),
    user: text('user').notNull().default(''),
    password: sealed.smtpPassword('password').notNull().default(''),
    fromAddress: text('from_address').notNull().default(''),
    fromName: text('from_name').notNull().default(options.smtpFromName),
    updatedAt: integer('updated_at').notNull(),
    // Additive columns (added via ALTER TABLE, must stay at end for sqlite-proxy position mapping)
    vaultConfig: text('vault_config'), // JSON vault reference | null
  })

  return { notificationChannels, notificationDeliveries, notificationDeliveryAttempts, smtpSettings }
}

export type NotifyTables = ReturnType<typeof defineNotifyTables>
