import { sqliteTable, integer, text, primaryKey } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'),
  createdAt: integer('created_at').notNull(),
})

export const monitorGroups = sqliteTable('monitor_groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  parentId: integer('parent_id'),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull(),
})

export const monitors = sqliteTable('monitors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  groupId: integer('group_id'),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'https'|'ping'|'dns'|'sqlserver'
  intervalSecs: integer('interval_secs').notNull().default(60),
  timeoutMs: integer('timeout_ms').notNull().default(10000),
  config: text('config').notNull(), // JSON
  currentStatus: text('current_status').notNull().default('pending'),
  lastCheckedAt: integer('last_checked_at'),
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

export const branding = sqliteTable('branding', {
  id: integer('id').primaryKey(),
  siteName: text('site_name').notNull().default('Status Page'),
  logoUrl: text('logo_url'),
  faviconUrl: text('favicon_url'),
  primaryColor: text('primary_color').notNull().default('#6366f1'),
  accentColor: text('accent_color').notNull().default('#f59e0b'),
  customCss: text('custom_css'),
  updatedAt: integer('updated_at').notNull(),
  // Additive columns (added via ALTER TABLE, must stay at end for sqlite-proxy position mapping)
  backgroundColor: text('background_color').notNull().default('#0f172a'),
  cardBackground: text('card_background').notNull().default('#0f172a'),
  cardBorderColor: text('card_border_color').notNull().default('#1e293b'),
  textColor: text('text_color').notNull().default('#f8fafc'),
  textMutedColor: text('text_muted_color').notNull().default('#94a3b8'),
  statusUpColor: text('status_up_color').notNull().default('#10b981'),
  statusDownColor: text('status_down_color').notNull().default('#ef4444'),
  statusDegradedColor: text('status_degraded_color').notNull().default('#f59e0b'),
})
