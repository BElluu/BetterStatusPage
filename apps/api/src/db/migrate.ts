import { sqlite } from './client.js'

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

CREATE TABLE IF NOT EXISTS locales (
  code               TEXT    PRIMARY KEY,
  name               TEXT    NOT NULL,
  is_default         INTEGER NOT NULL DEFAULT 0,
  translations       TEXT    NOT NULL DEFAULT '{}',
  admin_translations TEXT    NOT NULL DEFAULT '{}',
  updated_at         INTEGER NOT NULL
);
INSERT OR IGNORE INTO locales (code, name, is_default, translations, admin_translations, updated_at)
VALUES ('en', 'English', 1, '{}', '{}', 0);

CREATE TABLE IF NOT EXISTS branding (
  id INTEGER PRIMARY KEY,
  site_name TEXT NOT NULL DEFAULT 'Status Page',
  logo_url TEXT,
  favicon_url TEXT,
  primary_color TEXT NOT NULL DEFAULT '#6366f1',
  accent_color TEXT NOT NULL DEFAULT '#f59e0b',
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
`

const columnMigrations: Array<{ sql: string; desc: string }> = [
  { sql: `DROP TABLE IF EXISTS monitor_groups`, desc: 'drop monitor_groups (unused)' },
  { sql: `ALTER TABLE monitors DROP COLUMN group_id`, desc: 'monitors: drop legacy group_id' },
  { sql: `ALTER TABLE branding ADD COLUMN background_color TEXT NOT NULL DEFAULT '#0f172a'`, desc: 'branding.background_color' },
  { sql: `ALTER TABLE branding ADD COLUMN card_background TEXT NOT NULL DEFAULT '#0f172a'`, desc: 'branding.card_background' },
  { sql: `ALTER TABLE branding ADD COLUMN card_border_color TEXT NOT NULL DEFAULT '#1e293b'`, desc: 'branding.card_border_color' },
  { sql: `ALTER TABLE branding ADD COLUMN text_color TEXT NOT NULL DEFAULT '#f8fafc'`, desc: 'branding.text_color' },
  { sql: `ALTER TABLE branding ADD COLUMN text_muted_color TEXT NOT NULL DEFAULT '#94a3b8'`, desc: 'branding.text_muted_color' },
  { sql: `ALTER TABLE branding ADD COLUMN status_up_color TEXT NOT NULL DEFAULT '#10b981'`, desc: 'branding.status_up_color' },
  { sql: `ALTER TABLE branding ADD COLUMN status_down_color TEXT NOT NULL DEFAULT '#ef4444'`, desc: 'branding.status_down_color' },
  { sql: `ALTER TABLE branding ADD COLUMN status_degraded_color TEXT NOT NULL DEFAULT '#f59e0b'`, desc: 'branding.status_degraded_color' },
  { sql: `ALTER TABLE branding ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0`, desc: 'branding.enabled' },
  { sql: `ALTER TABLE branding ADD COLUMN logo_type TEXT NOT NULL DEFAULT 'image'`, desc: 'branding.logo_type' },
  { sql: `ALTER TABLE branding ADD COLUMN logo_text TEXT`, desc: 'branding.logo_text' },
  { sql: `ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`, desc: 'users.must_change_password' },
  { sql: `ALTER TABLE monitors ADD COLUMN retries INTEGER NOT NULL DEFAULT 1`, desc: 'monitors.retries' },
  { sql: `ALTER TABLE monitors ADD COLUMN webhook_token TEXT`, desc: 'monitors.webhook_token' },
]

/** Runs all migrations against the already-initialized DB. */
export function runMigrations(): void {
  sqlite.exec(migrations)
  for (const { sql, desc } of columnMigrations) {
    try { sqlite.exec(sql) } catch { /* column already exists */ }
    console.log(`✓ Column migration: ${desc}`)
  }
  console.log('✓ Migrations applied')
}
