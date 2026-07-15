import { sqliteTable, integer, text, primaryKey } from 'drizzle-orm/sqlite-core'
import { DEFAULT_BRANDING_COLORS } from '@bsp/shared'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'),
  mustChangePassword: integer('must_change_password').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  totpSecret: text('totp_secret'),
  totpEnabled: integer('totp_enabled').notNull().default(0),
  totpRecoveryCodes: text('totp_recovery_codes'),
})

export const authSessions = sqliteTable('auth_sessions', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  csrfTokenHash: text('csrf_token_hash').notNull(),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
})

export const monitors = sqliteTable('monitors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'https'|'ping'|'dns'|'sqlserver'
  intervalSecs: integer('interval_secs').notNull().default(60),
  timeoutMs: integer('timeout_ms').notNull().default(10000),
  retries: integer('retries').notNull().default(1),
  config: text('config').notNull(), // JSON
  currentStatus: text('current_status').notNull().default('pending'),
  lastCheckedAt: integer('last_checked_at'),
  webhookToken: text('webhook_token'),
  tags: text('tags').notNull().default('[]'), // JSON MonitorTag[]
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const monitorResults = sqliteTable('monitor_results', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  monitorId: integer('monitor_id').notNull(),
  status: text('status').notNull(),
  responseMs: integer('response_ms'),
  checkedAt: integer('checked_at').notNull(),
  errorMessage: text('error_message'),
})

export const incidents = sqliteTable('incidents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  status: text('status').notNull().default('investigating'),
  impact: text('impact').notNull().default('minor'),
  startedAt: integer('started_at').notNull(),
  resolvedAt: integer('resolved_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const incidentUpdates = sqliteTable('incident_updates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  incidentId: integer('incident_id').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull(),
  postedAt: integer('posted_at').notNull(),
})

export const incidentMonitors = sqliteTable('incident_monitors', {
  incidentId: integer('incident_id').notNull(),
  monitorId: integer('monitor_id').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.incidentId, t.monitorId] }),
}))

export const layout = sqliteTable('layout', {
  id: integer('id').primaryKey(),
  tree: text('tree').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const locales = sqliteTable('locales', {
  code:               text('code').primaryKey(),
  name:               text('name').notNull(),
  isDefault:          integer('is_default').notNull().default(0),
  translations:       text('translations').notNull().default('{}'),
  updatedAt:          integer('updated_at').notNull(),
})

export const vaults = sqliteTable('vaults', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull().default('local'), // 'local'
  description: text('description'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const vaultSecrets = sqliteTable('vault_secrets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vaultId: integer('vault_id').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'userpass' | 'value' | 'json'
  encryptedValue: text('encrypted_value').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const notificationChannels = sqliteTable('notification_channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'email' | 'webhook'
  config: text('config').notNull().default('{}'), // JSON
  enabled: integer('enabled').notNull().default(1),
  notifyOnRecovery: integer('notify_on_recovery').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const monitorNotificationChannels = sqliteTable('monitor_notification_channels', {
  monitorId: integer('monitor_id').notNull(),
  channelId: integer('channel_id').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.monitorId, t.channelId] }),
}))

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
  vaultConfig: text('vault_config'), // JSON VaultRef | null
  updatedAt: integer('updated_at').notNull(),
})

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

export const maintenanceWindows = sqliteTable('maintenance_windows', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  startsAt: integer('starts_at').notNull(),
  endsAt: integer('ends_at').notNull(),
  description: text('description'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const maintenanceWindowMonitors = sqliteTable('maintenance_window_monitors', {
  windowId: integer('window_id').notNull(),
  monitorId: integer('monitor_id').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.windowId, t.monitorId] }),
}))

export const monitorDependencies = sqliteTable('monitor_dependencies', {
  dependentId: integer('dependent_id').notNull(),
  dependsOnId: integer('depends_on_id').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.dependentId, t.dependsOnId] }),
}))

export const branding = sqliteTable('branding', {
  id: integer('id').primaryKey(),
  siteName: text('site_name').notNull().default('Status Page'),
  logoUrl: text('logo_url'),
  faviconUrl: text('favicon_url'),
  primaryColor: text('primary_color').notNull().default(DEFAULT_BRANDING_COLORS.primaryColor),
  accentColor: text('accent_color').notNull().default(DEFAULT_BRANDING_COLORS.accentColor),
  customCss: text('custom_css'),
  updatedAt: integer('updated_at').notNull(),
  // Additive columns (added via ALTER TABLE, must stay at end for sqlite-proxy position mapping)
  backgroundColor: text('background_color').notNull().default(DEFAULT_BRANDING_COLORS.backgroundColor),
  cardBackground: text('card_background').notNull().default(DEFAULT_BRANDING_COLORS.cardBackground),
  cardBorderColor: text('card_border_color').notNull().default(DEFAULT_BRANDING_COLORS.cardBorderColor),
  textColor: text('text_color').notNull().default(DEFAULT_BRANDING_COLORS.textColor),
  textMutedColor: text('text_muted_color').notNull().default(DEFAULT_BRANDING_COLORS.textMutedColor),
  statusUpColor: text('status_up_color').notNull().default(DEFAULT_BRANDING_COLORS.statusUpColor),
  statusDownColor: text('status_down_color').notNull().default(DEFAULT_BRANDING_COLORS.statusDownColor),
  statusDegradedColor: text('status_degraded_color').notNull().default(DEFAULT_BRANDING_COLORS.statusDegradedColor),
  enabled: integer('enabled').notNull().default(0),
  logoType: text('logo_type').notNull().default('image'),
  logoText: text('logo_text'),
  elevatedBackground: text('elevated_background').notNull().default(DEFAULT_BRANDING_COLORS.elevatedBackground),
  chartBackground: text('chart_background').notNull().default(DEFAULT_BRANDING_COLORS.chartBackground),
  chartGridColor: text('chart_grid_color').notNull().default(DEFAULT_BRANDING_COLORS.chartGridColor),
  logoLightUrl: text('logo_light_url'),
  logoDarkUrl: text('logo_dark_url'),
})
