import type { MigrationStep } from '@better-kit/db'

/** Notification channels, their delivery history and SMTP settings. Steps run in this order. */
export const notifyMigrations: readonly MigrationStep[] = [
  { kind: 'exec', sql: `
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
` },
  { kind: 'exec', sql: `
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
` },
  { kind: 'exec', sql: `
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
` },
  { kind: 'exec', sql: `
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
` },
  { kind: 'column', sql: `ALTER TABLE smtp_settings ADD COLUMN vault_config TEXT`, desc: 'smtp_settings.vault_config' },
  { kind: 'column', sql: `ALTER TABLE notification_channels ADD COLUMN alert_policy TEXT NOT NULL DEFAULT '{}'`, desc: 'notification_channels.alert_policy' },
  { kind: 'column', sql: `ALTER TABLE notification_deliveries ADD COLUMN suppression_reason TEXT`, desc: 'notification_deliveries.suppression_reason' },
  { kind: 'column', sql: `ALTER TABLE notification_deliveries ADD COLUMN group_key TEXT`, desc: 'notification_deliveries.group_key' },
  { kind: 'exec', sql: `CREATE INDEX IF NOT EXISTS idx_notification_deliveries_group ON notification_deliveries(group_key, status)` },
  { kind: 'exec', sql: `CREATE INDEX IF NOT EXISTS idx_notification_deliveries_throttle ON notification_deliveries(channel_id, monitor_id, event_type, created_at)` },
]
