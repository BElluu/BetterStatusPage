import { sqlite } from './client.js'
import { DEFAULT_BRANDING_COLORS } from '@bsp/shared'

const migrations = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  interval_secs INTEGER NOT NULL DEFAULT 60,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  config TEXT NOT NULL,
  current_status TEXT NOT NULL DEFAULT 'pending',
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  response_ms INTEGER,
  checked_at INTEGER NOT NULL,
  error_message TEXT,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_monitor_results_monitor_checked ON monitor_results(monitor_id, checked_at);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'investigating',
  impact TEXT NOT NULL DEFAULT 'minor',
  started_at INTEGER NOT NULL,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS incident_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  posted_at INTEGER NOT NULL,
  FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS incident_monitors (
  incident_id INTEGER NOT NULL,
  monitor_id INTEGER NOT NULL,
  PRIMARY KEY (incident_id, monitor_id)
);

CREATE TABLE IF NOT EXISTS layout (
  id INTEGER PRIMARY KEY,
  tree TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  notify_on_recovery INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_notification_channels (
  monitor_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  PRIMARY KEY (monitor_id, channel_id)
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  channel_name TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  monitor_id INTEGER,
  monitor_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  target_status TEXT NOT NULL,
  previous_status TEXT NOT NULL,
  variables TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at INTEGER,
  last_attempt_at INTEGER,
  delivered_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status_next ON notification_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_created ON notification_deliveries(created_at);

CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  FOREIGN KEY (delivery_id) REFERENCES notification_deliveries(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notification_delivery_attempts_delivery ON notification_delivery_attempts(delivery_id, attempt_number);

CREATE TABLE IF NOT EXISTS smtp_settings (
  id INTEGER PRIMARY KEY,
  host TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 587,
  secure INTEGER NOT NULL DEFAULT 0,
  user TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  from_address TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT 'BSP Alerts',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS locales (
  code               TEXT    PRIMARY KEY,
  name               TEXT    NOT NULL,
  is_default         INTEGER NOT NULL DEFAULT 0,
  translations       TEXT    NOT NULL DEFAULT '{}',
  updated_at         INTEGER NOT NULL
);
INSERT OR IGNORE INTO locales (code, name, is_default, translations, updated_at)
VALUES ('en', 'English', 1, '{}', 0);

CREATE TABLE IF NOT EXISTS branding (
  id INTEGER PRIMARY KEY,
  site_name TEXT NOT NULL DEFAULT 'Status Page',
  logo_url TEXT,
  favicon_url TEXT,
  primary_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.primaryColor}',
  accent_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.accentColor}',
  custom_css TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vaults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'local',
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_secrets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE CASCADE,
  UNIQUE (vault_id, name)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  csrf_token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`

const auditMigration = `
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  user_email TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  entity_name TEXT NOT NULL,
  diff TEXT,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
`

const maintenanceMigration = `
CREATE TABLE IF NOT EXISTS maintenance_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS maintenance_window_monitors (
  window_id INTEGER NOT NULL,
  monitor_id INTEGER NOT NULL,
  PRIMARY KEY (window_id, monitor_id),
  FOREIGN KEY (window_id) REFERENCES maintenance_windows(id) ON DELETE CASCADE
);
`

const dependenciesMigration = `
CREATE TABLE IF NOT EXISTS monitor_dependencies (
  dependent_id  INTEGER NOT NULL,
  depends_on_id INTEGER NOT NULL,
  PRIMARY KEY (dependent_id, depends_on_id),
  FOREIGN KEY (dependent_id)  REFERENCES monitors(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_id) REFERENCES monitors(id) ON DELETE CASCADE
);
`

const columnMigrations: Array<{ sql: string; desc: string }> = [
  { sql: `DROP TABLE IF EXISTS monitor_groups`, desc: 'drop monitor_groups (unused)' },
  { sql: `ALTER TABLE monitors DROP COLUMN group_id`, desc: 'monitors: drop legacy group_id' },
  { sql: `ALTER TABLE branding ADD COLUMN background_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.backgroundColor}'`, desc: 'branding.background_color' },
  { sql: `ALTER TABLE branding ADD COLUMN card_background TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.cardBackground}'`, desc: 'branding.card_background' },
  { sql: `ALTER TABLE branding ADD COLUMN card_border_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.cardBorderColor}'`, desc: 'branding.card_border_color' },
  { sql: `ALTER TABLE branding ADD COLUMN text_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.textColor}'`, desc: 'branding.text_color' },
  { sql: `ALTER TABLE branding ADD COLUMN text_muted_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.textMutedColor}'`, desc: 'branding.text_muted_color' },
  { sql: `ALTER TABLE branding ADD COLUMN status_up_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.statusUpColor}'`, desc: 'branding.status_up_color' },
  { sql: `ALTER TABLE branding ADD COLUMN status_down_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.statusDownColor}'`, desc: 'branding.status_down_color' },
  { sql: `ALTER TABLE branding ADD COLUMN status_degraded_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.statusDegradedColor}'`, desc: 'branding.status_degraded_color' },
  { sql: `ALTER TABLE branding ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0`, desc: 'branding.enabled' },
  { sql: `ALTER TABLE branding ADD COLUMN logo_type TEXT NOT NULL DEFAULT 'image'`, desc: 'branding.logo_type' },
  { sql: `ALTER TABLE branding ADD COLUMN logo_text TEXT`, desc: 'branding.logo_text' },
  { sql: `ALTER TABLE branding ADD COLUMN elevated_background TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.elevatedBackground}'`, desc: 'branding.elevated_background' },
  { sql: `ALTER TABLE branding ADD COLUMN chart_background TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.chartBackground}'`, desc: 'branding.chart_background' },
  { sql: `ALTER TABLE branding ADD COLUMN chart_grid_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.chartGridColor}'`, desc: 'branding.chart_grid_color' },
  { sql: `ALTER TABLE branding ADD COLUMN logo_light_url TEXT`, desc: 'branding.logo_light_url' },
  { sql: `ALTER TABLE branding ADD COLUMN logo_dark_url TEXT`, desc: 'branding.logo_dark_url' },
  { sql: `ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`, desc: 'users.must_change_password' },
  { sql: `ALTER TABLE users ADD COLUMN totp_secret TEXT`, desc: 'users.totp_secret' },
  { sql: `ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`, desc: 'users.totp_enabled' },
  { sql: `ALTER TABLE users ADD COLUMN totp_recovery_codes TEXT`, desc: 'users.totp_recovery_codes' },
  { sql: `ALTER TABLE monitors ADD COLUMN retries INTEGER NOT NULL DEFAULT 1`, desc: 'monitors.retries' },
  { sql: `ALTER TABLE monitors ADD COLUMN webhook_token TEXT`, desc: 'monitors.webhook_token' },
  { sql: `ALTER TABLE smtp_settings ADD COLUMN vault_config TEXT`, desc: 'smtp_settings.vault_config' },
  { sql: `ALTER TABLE monitors ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`, desc: 'monitors.tags' },
]

function runDataMigration(name: string, migrate: () => void): void {
  sqlite.exec('BEGIN IMMEDIATE')
  try {
    const applied = sqlite.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name)
    if (!applied) {
      migrate()
      sqlite.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now())
    }
    sqlite.exec('COMMIT')
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }
}

function alignBrandingDefaultsWithLightMode(): void {
  runDataMigration('branding-defaults-match-light-mode-v2', () => {
    sqlite.exec(`
      UPDATE branding SET
        primary_color = CASE WHEN primary_color = '#5256a4' THEN '${DEFAULT_BRANDING_COLORS.primaryColor}' ELSE primary_color END,
        accent_color = CASE WHEN accent_color = '#5c5faa' THEN '${DEFAULT_BRANDING_COLORS.accentColor}' ELSE accent_color END,
        background_color = CASE WHEN background_color = '#faf8ff' THEN '${DEFAULT_BRANDING_COLORS.backgroundColor}' ELSE background_color END,
        card_background = CASE WHEN card_background = '#f2f0fd' THEN '${DEFAULT_BRANDING_COLORS.cardBackground}' ELSE card_background END,
        card_border_color = CASE WHEN card_border_color = '#c8c5d0' THEN '${DEFAULT_BRANDING_COLORS.cardBorderColor}' ELSE card_border_color END,
        text_color = CASE WHEN text_color = '#1b1b22' THEN '${DEFAULT_BRANDING_COLORS.textColor}' ELSE text_color END,
        text_muted_color = CASE WHEN text_muted_color = '#5d5c72' THEN '${DEFAULT_BRANDING_COLORS.textMutedColor}' ELSE text_muted_color END,
        status_up_color = CASE WHEN status_up_color = '#1a7f37' THEN '${DEFAULT_BRANDING_COLORS.statusUpColor}' ELSE status_up_color END,
        status_down_color = CASE WHEN status_down_color = '#c0392b' THEN '${DEFAULT_BRANDING_COLORS.statusDownColor}' ELSE status_down_color END,
        status_degraded_color = CASE WHEN status_degraded_color = '#b05c00' THEN '${DEFAULT_BRANDING_COLORS.statusDegradedColor}' ELSE status_degraded_color END
      WHERE enabled = 0 OR (
        primary_color = '#5256a4' AND accent_color = '#5c5faa' AND background_color = '#faf8ff'
        AND card_background = '#f2f0fd' AND card_border_color = '#c8c5d0'
        AND text_color = '#1b1b22' AND text_muted_color = '#5d5c72'
        AND status_up_color = '#1a7f37' AND status_down_color = '#c0392b'
        AND status_degraded_color = '#b05c00'
      )
    `)
  })
}

function migrateLegacyLogoVariants(): void {
  runDataMigration('branding-legacy-logo-variants-v1', () => {
    sqlite.exec(`
      UPDATE branding SET
        logo_light_url = COALESCE(logo_light_url, logo_url),
        logo_dark_url = COALESCE(logo_dark_url, logo_url)
      WHERE logo_url IS NOT NULL
    `)
  })
}

/** Runs all migrations against the already-initialized DB. */
export function runMigrations(): void {
  sqlite.exec(migrations)
  sqlite.exec(auditMigration)
  sqlite.exec(maintenanceMigration)
  sqlite.exec(dependenciesMigration)
  for (const { sql, desc } of columnMigrations) {
    try { sqlite.exec(sql) } catch { /* column already exists */ }
    console.log(`✓ Column migration: ${desc}`)
  }
  alignBrandingDefaultsWithLightMode()
  migrateLegacyLogoVariants()
  console.log('✓ Migrations applied')
}
