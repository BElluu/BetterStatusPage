import { sqliteTable, integer, text, real, primaryKey } from 'drizzle-orm/sqlite-core'
import { DEFAULT_BRANDING_COLORS, DEFAULT_UPTIME_THRESHOLDS } from '@bsp/shared'
import { randomEntityKey } from '../lib/entityKey.js'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'),
  createdAt: integer('created_at').notNull(),
  // Additive columns (added via ALTER TABLE, must stay at end for sqlite-proxy position mapping)
  mustChangePassword: integer('must_change_password').notNull().default(0),
  totpSecret: text('totp_secret'),
  totpEnabled: integer('totp_enabled').notNull().default(0),
  totpRecoveryCodes: text('totp_recovery_codes'),
  // SSO identity bound on the first OIDC sign-in; later sign-ins match on it instead of the email.
  oidcIssuer: text('oidc_issuer'),
  oidcSubject: text('oidc_subject'),
})

export const authSessions = sqliteTable('auth_sessions', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  csrfTokenHash: text('csrf_token_hash').notNull(),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  // 'password' or 'oidc'. An SSO session never asks for the temporary password to be changed.
  authMethod: text('auth_method').notNull().default('password'),
  // When the user last proved who they are in this session: the sign-in, or a later SSO confirmation.
  verifiedAt: integer('verified_at'),
})

/** Long-lived bearer credentials for scripts and CI. Only the SHA-256 of the token is stored; revoking deletes the row. */
export const apiTokens = sqliteTable('api_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  /** Leading characters of the token, so it can be recognised in the list. */
  prefix: text('prefix').notNull(),
  /** 'admin' | 'operator' | 'branding'. */
  role: text('role').notNull(),
  /** The admin who created it; the token stops working when this user is gone or no longer an admin. */
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at'),
  lastUsedAt: integer('last_used_at'),
})

export const monitors = sqliteTable('monitors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'https'|'ping'|'dns'|'sqlserver'|'postgresql'|'mysql'|'mongodb'
  intervalSecs: integer('interval_secs').notNull().default(60),
  timeoutMs: integer('timeout_ms').notNull().default(10000),
  config: text('config').notNull(), // JSON
  currentStatus: text('current_status').notNull().default('pending'),
  lastCheckedAt: integer('last_checked_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  // Additive columns (added via ALTER TABLE, must stay at end for sqlite-proxy position mapping)
  retries: integer('retries').notNull().default(1),
  webhookToken: text('webhook_token'),
  tags: text('tags').notNull().default('[]'), // JSON MonitorTag[]
  failureThreshold: integer('failure_threshold').notNull().default(1),
  recoveryThreshold: integer('recovery_threshold').notNull().default(1),
  /** Last status an alert was evaluated against — drives threshold debouncing, not the public status. */
  alertConfirmedStatus: text('alert_confirmed_status').notNull().default('pending'),
  /** Candidate status currently accumulating consecutive observations. */
  alertPendingStatus: text('alert_pending_status'),
  alertPendingCount: integer('alert_pending_count').notNull().default(0),
  /** Expiry of the TLS certificate last read from an HTTPS monitor's endpoint. */
  certExpiresAt: integer('cert_expires_at'),
  certCheckedAt: integer('cert_checked_at'),
  /** Smallest days-before-expiry milestone already warned about for the current certificate. */
  certWarnedDays: integer('cert_warned_days'),
  /** Stable identifier for config-as-code and API clients; unlike `id` it survives export/import. */
  key: text('key').notNull().unique().$defaultFn(randomEntityKey),
})

export const monitorResults = sqliteTable('monitor_results', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  monitorId: integer('monitor_id').notNull(),
  status: text('status').notNull(),
  responseMs: integer('response_ms'),
  checkedAt: integer('checked_at').notNull(),
  errorMessage: text('error_message'),
  // Additive columns (added via ALTER TABLE, must stay at end for sqlite-proxy position mapping)
  /** 1 for a failure not (yet) confirmed by the monitor's failure threshold; it does not lower uptime. */
  unconfirmed: integer('unconfirmed').notNull().default(0),
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
  type: text('type').notNull().default('local'), // 'local' | 'hashicorp'
  description: text('description'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  /** Encrypted JSON connection settings of a 'hashicorp' vault; NULL for 'local'. Never sent to the browser. */
  connectionConfig: text('connection_config'),
})

export const vaultSecrets = sqliteTable('vault_secrets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vaultId: integer('vault_id').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'userpass' | 'value' | 'json'
  /** Local vault: the encrypted value. HashiCorp vault: the encrypted reference `{ path, key? }`. */
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
  // Additive columns (added via ALTER TABLE, must stay at end for sqlite-proxy position mapping)
  alertPolicy: text('alert_policy').notNull().default('{}'), // JSON ChannelAlertPolicy
  /** Stable identifier for config-as-code and API clients; unlike `id` it survives export/import. */
  key: text('key').notNull().unique().$defaultFn(randomEntityKey),
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

export const oidcSettings = sqliteTable('oidc_settings', {
  id: integer('id').primaryKey(),
  enabled: integer('enabled').notNull().default(0),
  issuer: text('issuer').notNull().default(''),
  clientId: text('client_id').notNull().default(''),
  /** AES-256-GCM encrypted via crypto/vault.ts; empty when no secret is set. */
  clientSecret: text('client_secret').notNull().default(''),
  scopes: text('scopes').notNull().default(''),
  redirectUri: text('redirect_uri').notNull().default(''),
  buttonLabel: text('button_label').notNull().default(''),
  allowUnverifiedEmail: integer('allow_unverified_email').notNull().default(0),
  disablePasswordLogin: integer('disable_password_login').notNull().default(0),
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
  statusPartialColor: text('status_partial_color').notNull().default(DEFAULT_BRANDING_COLORS.statusPartialColor),
  uptimeThresholdUp: real('uptime_threshold_up').notNull().default(DEFAULT_UPTIME_THRESHOLDS.uptimeThresholdUp),
  uptimeThresholdDegraded: real('uptime_threshold_degraded').notNull().default(DEFAULT_UPTIME_THRESHOLDS.uptimeThresholdDegraded),
  uptimeThresholdPartial: real('uptime_threshold_partial').notNull().default(DEFAULT_UPTIME_THRESHOLDS.uptimeThresholdPartial),
  showHero: integer('show_hero').notNull().default(1),
  showFooter: integer('show_footer').notNull().default(1),
  showProjectLink: integer('show_project_link').notNull().default(1),
})

export const subscriptionSettings = sqliteTable('subscription_settings', {
  id: integer('id').primaryKey(),
  enabled: integer('enabled').notNull().default(0),
  allowEmail: integer('allow_email').notNull().default(1),
  allowWebhook: integer('allow_webhook').notNull().default(0),
  allowedEvents: text('allowed_events').notNull().default('[]'), // JSON SubscriberEventType[]
  allowComponentScope: integer('allow_component_scope').notNull().default(1),
  /** Unused since the public URL moved to the PUBLIC_URL environment variable; kept for sqlite-proxy position mapping. */
  publicUrl: text('public_url').notNull().default(''),
  rssEnabled: integer('rss_enabled').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  // Additive columns (added via ALTER TABLE, must stay at end for sqlite-proxy position mapping)
  allowSlack: integer('allow_slack').notNull().default(1),
  apiEnabled: integer('api_enabled').notNull().default(1),
})

export const subscribers = sqliteTable('subscribers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(), // 'email' | 'webhook'
  /** `email:<address>` or `webhook:<url>` — one subscription per destination. */
  targetKey: text('target_key').notNull().unique(),
  /** Delivery target for email subscribers; empty for webhook subscribers. */
  email: text('email').notNull(),
  webhookUrl: text('webhook_url'),
  status: text('status').notNull().default('pending'),
  events: text('events').notNull().default('[]'), // JSON SubscriberEventType[]
  monitorIds: text('monitor_ids').notNull().default('[]'), // JSON number[] — empty = everything
  tags: text('tags').notNull().default('[]'), // JSON string[]
  confirmTokenHash: text('confirm_token_hash'),
  confirmExpiresAt: integer('confirm_expires_at'),
  confirmationSentAt: integer('confirmation_sent_at'),
  /** Long-lived capability behind the manage and unsubscribe links, so it must stay readable. */
  manageToken: text('manage_token').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  confirmedAt: integer('confirmed_at'),
  unsubscribedAt: integer('unsubscribed_at'),
  lastNotifiedAt: integer('last_notified_at'),
  lastError: text('last_error'),
  updatedAt: integer('updated_at').notNull(),
  // Additive columns (added via ALTER TABLE, must stay at end for sqlite-proxy position mapping)
  webhookMethod: text('webhook_method').notNull().default('POST'),
  /** AES-GCM encrypted JSON WebhookHeader[] — values are usually credentials. */
  webhookHeaders: text('webhook_headers'),
  notifyOnFailure: integer('notify_on_failure').notNull().default(0),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  failureNotifiedAt: integer('failure_notified_at'),
  disabledAt: integer('disabled_at'),
})

export const subscriberDeliveries = sqliteTable('subscriber_deliveries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  subscriberId: integer('subscriber_id').notNull(),
  eventType: text('event_type').notNull(),
  event: text('event').notNull(), // JSON SubscriberEvent, rendered per subscriber at send time
  status: text('status').notNull().default('pending'), // 'pending' | 'delivered' | 'failed' | 'cancelled'
  attemptCount: integer('attempt_count').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(4),
  nextAttemptAt: integer('next_attempt_at'),
  lastError: text('last_error'),
  deliveredAt: integer('delivered_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const statusPageAccess = sqliteTable('status_page_access', {
  id: integer('id').primaryKey(),
  /** 1 = only signed-in users may view the status page, its feeds and its API. */
  private: integer('private').notNull().default(0),
  /** While private: an SSO sign-in without a matching account creates a viewer account. */
  ssoCreateViewers: integer('sso_create_viewers').notNull().default(0),
  /** JSON string[] of email domains an SSO sign-in may create a viewer account for. */
  ssoViewerDomains: text('sso_viewer_domains').notNull().default('[]'),
  updatedAt: integer('updated_at').notNull(),
})
