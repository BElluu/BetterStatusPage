import { DEFAULT_BRANDING_COLORS, DEFAULT_EMAIL_BODY, DEFAULT_EMAIL_SUBJECT, DEFAULT_UPTIME_THRESHOLDS } from '@bsp/shared'
import { backfillKeys } from '@better-kit/config-as-code'
import type { MigrationStep } from '@better-kit/db'
import { TEMPLATE_KEYS } from '@better-kit/notify'
import { createSecretBox } from '@better-kit/vault'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { sealStoredSecrets } from '../../../services/sealedColumns.js'
import { rebuildDailyResults } from '../../dailyResults.js'

/**
 * A channel used to word the messages about an action with its own message fields, like those about monitors. Now an
 * action is worded by the channel's wording for actions, so the fields of every channel that tells an action's runs
 * are copied there, and what such a channel sends stays what it was. A channel that still has the stock email template
 * has nothing to copy: the standard wording of an action is what it is meant to get.
 */
function copyWordingToActions(sqlite: DatabaseSync): void {
  const linked = sqlite.prepare('SELECT DISTINCT channel_id AS id FROM action_failure_channels').all() as { id: number }[]
  const read = sqlite.prepare('SELECT type, config FROM notification_channels WHERE id = ?')
  const write = sqlite.prepare('UPDATE notification_channels SET config = ? WHERE id = ?')
  for (const { id } of linked) {
    const row = read.get(id) as { type: string; config: string } | undefined
    if (!row) continue
    let config: Record<string, unknown>
    try { config = JSON.parse(row.config) as Record<string, unknown> } catch { continue }
    const keys = (TEMPLATE_KEYS as Record<string, readonly string[]>)[row.type] ?? []
    const existing = config['eventOverrides'] as Record<string, unknown> | undefined
    if (existing && typeof existing === 'object' && 'action' in existing) continue
    const fields: Record<string, string> = {}
    for (const key of keys) if (typeof config[key] === 'string' && config[key] !== '') fields[key] = config[key] as string
    if (row.type === 'email' && fields['subject'] === DEFAULT_EMAIL_SUBJECT && fields['body'] === DEFAULT_EMAIL_BODY) continue
    if (Object.keys(fields).length === 0) continue
    write.run(JSON.stringify({ ...config, eventOverrides: { ...(existing && typeof existing === 'object' ? existing : {}), action: fields } }), id)
  }
}

/** Everything the application adds to the shared tables. Steps run in this order. */
export const appMigrations: readonly MigrationStep[] = [
  { kind: 'exec', sql: `
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
` },
  { kind: 'exec', sql: `
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
` },
  { kind: 'exec', sql: `
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
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS incident_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  posted_at INTEGER NOT NULL,
  FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
);
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS incident_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  resolved_body TEXT NOT NULL,
  impact TEXT NOT NULL DEFAULT 'major',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS incident_monitors (
  incident_id INTEGER NOT NULL,
  monitor_id INTEGER NOT NULL,
  PRIMARY KEY (incident_id, monitor_id)
);
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS layout (
  id INTEGER PRIMARY KEY,
  tree TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS monitor_notification_channels (
  monitor_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  PRIMARY KEY (monitor_id, channel_id)
);
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS monitor_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL,
  action_id INTEGER NOT NULL,
  on_status TEXT NOT NULL,
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  cooldown_minutes INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_monitor_actions_link ON monitor_actions(monitor_id, action_id, on_status);
` },
  // The channels of an action are told about its failures and, when they are set to, its successes. Runs before the
  // CREATE below, so a database from an older release keeps its rows under the new name.
  { kind: 'data', name: 'action-failure-channels-renamed-v1', run(sqlite) {
    const old = sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'action_failure_channels'`).get()
    if (!old) return
    copyWordingToActions(sqlite)
    const renamed = sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'action_notification_channels'`).get()
    // A build that created the new table before this step ran leaves both; the rows of the old one are moved over.
    if (renamed) {
      sqlite.exec(`
INSERT OR IGNORE INTO action_notification_channels (action_id, channel_id) SELECT action_id, channel_id FROM action_failure_channels;
DROP TABLE action_failure_channels;
`)
      return
    }
    sqlite.exec(`
DROP INDEX IF EXISTS idx_action_failure_channels_link;
ALTER TABLE action_failure_channels RENAME TO action_notification_channels;
`)
  } },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS action_notification_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_action_notification_channels_link ON action_notification_channels(action_id, channel_id);
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS action_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id INTEGER NOT NULL,
  action_name TEXT NOT NULL,
  monitor_id INTEGER,
  monitor_name TEXT NOT NULL,
  on_status TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  variables TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at INTEGER,
  last_attempt_at INTEGER,
  completed_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_runs_status_next ON action_runs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_action_runs_monitor ON action_runs(monitor_id, status);
CREATE INDEX IF NOT EXISTS idx_action_runs_created ON action_runs(created_at);
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS locales (
  code               TEXT    PRIMARY KEY,
  name               TEXT    NOT NULL,
  is_default         INTEGER NOT NULL DEFAULT 0,
  translations       TEXT    NOT NULL DEFAULT '{}',
  updated_at         INTEGER NOT NULL
);
INSERT OR IGNORE INTO locales (code, name, is_default, translations, updated_at)
VALUES ('en', 'English', 1, '{}', 0);
` },
  { kind: 'exec', sql: `
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
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS maintenance_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS maintenance_window_monitors (
  window_id INTEGER NOT NULL,
  monitor_id INTEGER NOT NULL,
  PRIMARY KEY (window_id, monitor_id),
  FOREIGN KEY (window_id) REFERENCES maintenance_windows(id) ON DELETE CASCADE
);
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS monitor_dependencies (
  dependent_id  INTEGER NOT NULL,
  depends_on_id INTEGER NOT NULL,
  PRIMARY KEY (dependent_id, depends_on_id),
  FOREIGN KEY (dependent_id)  REFERENCES monitors(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_id) REFERENCES monitors(id) ON DELETE CASCADE
);
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS subscription_settings (
  id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  allow_email INTEGER NOT NULL DEFAULT 1,
  allow_webhook INTEGER NOT NULL DEFAULT 0,
  allowed_events TEXT NOT NULL DEFAULT '[]',
  allow_component_scope INTEGER NOT NULL DEFAULT 1,
  public_url TEXT NOT NULL DEFAULT '',
  rss_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  target_key TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  webhook_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  events TEXT NOT NULL DEFAULT '[]',
  monitor_ids TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  confirm_token_hash TEXT,
  confirm_expires_at INTEGER,
  confirmation_sent_at INTEGER,
  manage_token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  unsubscribed_at INTEGER,
  last_notified_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status);
CREATE INDEX IF NOT EXISTS idx_subscribers_confirm_token ON subscribers(confirm_token_hash);
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS subscriber_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 4,
  next_attempt_at INTEGER,
  last_error TEXT,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_subscriber_deliveries_status_next ON subscriber_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_subscriber_deliveries_created ON subscriber_deliveries(created_at);
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS status_page_access (
  id INTEGER PRIMARY KEY,
  private INTEGER NOT NULL DEFAULT 0,
  sso_create_viewers INTEGER NOT NULL DEFAULT 0,
  sso_viewer_domains TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
` },
  { kind: 'exec', sql: `DROP TABLE IF EXISTS monitor_groups` },
  { kind: 'column', sql: `ALTER TABLE monitors DROP COLUMN group_id`, desc: 'monitors: drop legacy group_id' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN background_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.backgroundColor}'`, desc: 'branding.background_color' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN card_background TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.cardBackground}'`, desc: 'branding.card_background' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN card_border_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.cardBorderColor}'`, desc: 'branding.card_border_color' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN text_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.textColor}'`, desc: 'branding.text_color' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN text_muted_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.textMutedColor}'`, desc: 'branding.text_muted_color' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN status_up_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.statusUpColor}'`, desc: 'branding.status_up_color' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN status_down_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.statusDownColor}'`, desc: 'branding.status_down_color' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN status_degraded_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.statusDegradedColor}'`, desc: 'branding.status_degraded_color' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0`, desc: 'branding.enabled' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN logo_type TEXT NOT NULL DEFAULT 'image'`, desc: 'branding.logo_type' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN logo_text TEXT`, desc: 'branding.logo_text' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN elevated_background TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.elevatedBackground}'`, desc: 'branding.elevated_background' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN chart_background TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.chartBackground}'`, desc: 'branding.chart_background' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN chart_grid_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.chartGridColor}'`, desc: 'branding.chart_grid_color' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN logo_light_url TEXT`, desc: 'branding.logo_light_url' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN logo_dark_url TEXT`, desc: 'branding.logo_dark_url' },
  { kind: 'column', sql: `ALTER TABLE monitors ADD COLUMN retries INTEGER NOT NULL DEFAULT 1`, desc: 'monitors.retries' },
  { kind: 'column', sql: `ALTER TABLE monitors ADD COLUMN webhook_token TEXT`, desc: 'monitors.webhook_token' },
  { kind: 'column', sql: `ALTER TABLE monitors ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`, desc: 'monitors.tags' },
  { kind: 'column', sql: `ALTER TABLE monitors ADD COLUMN failure_threshold INTEGER NOT NULL DEFAULT 1`, desc: 'monitors.failure_threshold' },
  { kind: 'column', sql: `ALTER TABLE monitors ADD COLUMN recovery_threshold INTEGER NOT NULL DEFAULT 1`, desc: 'monitors.recovery_threshold' },
  { kind: 'column', sql: `ALTER TABLE monitors ADD COLUMN alert_confirmed_status TEXT NOT NULL DEFAULT 'pending'`, desc: 'monitors.alert_confirmed_status' },
  { kind: 'column', sql: `ALTER TABLE monitors ADD COLUMN alert_pending_status TEXT`, desc: 'monitors.alert_pending_status' },
  { kind: 'column', sql: `ALTER TABLE monitors ADD COLUMN alert_pending_count INTEGER NOT NULL DEFAULT 0`, desc: 'monitors.alert_pending_count' },
  { kind: 'column', sql: `ALTER TABLE subscription_settings ADD COLUMN allow_slack INTEGER NOT NULL DEFAULT 1`, desc: 'subscription_settings.allow_slack' },
  { kind: 'column', sql: `ALTER TABLE subscription_settings ADD COLUMN api_enabled INTEGER NOT NULL DEFAULT 1`, desc: 'subscription_settings.api_enabled' },
  { kind: 'column', sql: `ALTER TABLE subscribers ADD COLUMN webhook_method TEXT NOT NULL DEFAULT 'POST'`, desc: 'subscribers.webhook_method' },
  { kind: 'column', sql: `ALTER TABLE subscribers ADD COLUMN webhook_headers TEXT`, desc: 'subscribers.webhook_headers' },
  { kind: 'column', sql: `ALTER TABLE subscribers ADD COLUMN notify_on_failure INTEGER NOT NULL DEFAULT 0`, desc: 'subscribers.notify_on_failure' },
  { kind: 'column', sql: `ALTER TABLE subscribers ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0`, desc: 'subscribers.consecutive_failures' },
  { kind: 'column', sql: `ALTER TABLE subscribers ADD COLUMN failure_notified_at INTEGER`, desc: 'subscribers.failure_notified_at' },
  { kind: 'column', sql: `ALTER TABLE subscribers ADD COLUMN disabled_at INTEGER`, desc: 'subscribers.disabled_at' },
  { kind: 'column', sql: `ALTER TABLE monitor_results ADD COLUMN unconfirmed INTEGER NOT NULL DEFAULT 0`, desc: 'monitor_results.unconfirmed' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN status_partial_color TEXT NOT NULL DEFAULT '${DEFAULT_BRANDING_COLORS.statusPartialColor}'`, desc: 'branding.status_partial_color' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN uptime_threshold_up REAL NOT NULL DEFAULT ${DEFAULT_UPTIME_THRESHOLDS.uptimeThresholdUp}`, desc: 'branding.uptime_threshold_up' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN uptime_threshold_degraded REAL NOT NULL DEFAULT ${DEFAULT_UPTIME_THRESHOLDS.uptimeThresholdDegraded}`, desc: 'branding.uptime_threshold_degraded' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN uptime_threshold_partial REAL NOT NULL DEFAULT ${DEFAULT_UPTIME_THRESHOLDS.uptimeThresholdPartial}`, desc: 'branding.uptime_threshold_partial' },
  { kind: 'column', sql: `ALTER TABLE monitors ADD COLUMN cert_expires_at INTEGER`, desc: 'monitors.cert_expires_at' },
  { kind: 'column', sql: `ALTER TABLE monitors ADD COLUMN cert_checked_at INTEGER`, desc: 'monitors.cert_checked_at' },
  { kind: 'column', sql: `ALTER TABLE monitors ADD COLUMN cert_warned_days INTEGER`, desc: 'monitors.cert_warned_days' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN show_hero INTEGER NOT NULL DEFAULT 1`, desc: 'branding.show_hero' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN show_footer INTEGER NOT NULL DEFAULT 1`, desc: 'branding.show_footer' },
  { kind: 'column', sql: `ALTER TABLE branding ADD COLUMN show_project_link INTEGER NOT NULL DEFAULT 1`, desc: 'branding.show_project_link' },
  // SQLite cannot add a UNIQUE column; existing rows are filled by backfillEntityKeys, which then adds the unique index.
  { kind: 'column', sql: `ALTER TABLE monitors ADD COLUMN key TEXT NOT NULL DEFAULT ''`, desc: 'monitors.key' },
  { kind: 'column', sql: `ALTER TABLE actions ADD COLUMN key TEXT NOT NULL DEFAULT ''`, desc: 'actions.key' },
  { kind: 'column', sql: `ALTER TABLE monitors ADD COLUMN auto_incident_minutes INTEGER`, desc: 'monitors.auto_incident_minutes' },
  { kind: 'column', sql: `ALTER TABLE monitors ADD COLUMN auto_incident_mode TEXT NOT NULL DEFAULT 'draft'`, desc: 'monitors.auto_incident_mode' },
  { kind: 'column', sql: `ALTER TABLE monitors ADD COLUMN auto_incident_template_id INTEGER`, desc: 'monitors.auto_incident_template_id' },
  { kind: 'column', sql: `ALTER TABLE monitors ADD COLUMN failing_since INTEGER`, desc: 'monitors.failing_since' },
  { kind: 'column', sql: `ALTER TABLE monitors ADD COLUMN auto_created_by_token_id INTEGER`, desc: 'monitors.auto_created_by_token_id' },
  { kind: 'column', sql: `ALTER TABLE incidents ADD COLUMN draft INTEGER NOT NULL DEFAULT 0`, desc: 'incidents.draft' },
  { kind: 'column', sql: `ALTER TABLE incidents ADD COLUMN auto_monitor_id INTEGER`, desc: 'incidents.auto_monitor_id' },
  { kind: 'column', sql: `ALTER TABLE maintenance_windows ADD COLUMN recurrence TEXT NOT NULL DEFAULT 'none'`, desc: 'maintenance_windows.recurrence' },
  { kind: 'column', sql: `ALTER TABLE maintenance_windows ADD COLUMN recurrence_days TEXT`, desc: 'maintenance_windows.recurrence_days' },
  { kind: 'column', sql: `ALTER TABLE maintenance_windows ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'`, desc: 'maintenance_windows.timezone' },
  { kind: 'column', sql: `ALTER TABLE maintenance_windows ADD COLUMN recurrence_until INTEGER`, desc: 'maintenance_windows.recurrence_until' },
  { kind: 'column', sql: `ALTER TABLE maintenance_windows ADD COLUMN ended_early_start INTEGER`, desc: 'maintenance_windows.ended_early_start' },
  { kind: 'column', sql: `ALTER TABLE maintenance_windows ADD COLUMN ended_early_at INTEGER`, desc: 'maintenance_windows.ended_early_at' },
  { kind: 'exec', sql: `CREATE INDEX IF NOT EXISTS idx_incidents_auto_monitor ON incidents(auto_monitor_id)` },
  { kind: 'exec', sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_templates_name ON incident_templates(name)` },
  { kind: 'column', sql: `ALTER TABLE incidents ADD COLUMN title_translations TEXT NOT NULL DEFAULT '{}'`, desc: 'incidents.title_translations' },
  { kind: 'column', sql: `ALTER TABLE incident_updates ADD COLUMN body_translations TEXT NOT NULL DEFAULT '{}'`, desc: 'incident_updates.body_translations' },
  { kind: 'column', sql: `ALTER TABLE incident_templates ADD COLUMN translations TEXT NOT NULL DEFAULT '{}'`, desc: 'incident_templates.translations' },
  { kind: 'data', name: 'branding-defaults-match-light-mode-v2', run(sqlite) {
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
  } },
  { kind: 'data', name: 'branding-legacy-logo-variants-v1', run(sqlite) {
    sqlite.exec(`
      UPDATE branding SET
        logo_light_url = COALESCE(logo_light_url, logo_url),
        logo_dark_url = COALESCE(logo_dark_url, logo_url)
      WHERE logo_url IS NOT NULL
    `)
  } },
  /**
   * Alert thresholds debounce against `alert_confirmed_status`. Existing rows default it to
   * 'pending', which would make the first check after upgrade look like a state change; seed it
   * from the status the monitor is already in so the upgrade is silent.
   */
  { kind: 'data', name: 'monitors-seed-alert-confirmed-status-v1', run(sqlite) {
    sqlite.exec(`UPDATE monitors SET alert_confirmed_status = current_status`)
  } },
  /**
   * Monitors and notification channels gained a unique `key`. Rows that predate it get one from their name, in id
   * order, the same way the API derives it for a new row (`name`, then `name-2`, `name-3`, ...).
   */
  { kind: 'data', name: 'entity-keys-backfill-v1', run: (sqlite) => backfillKeys(sqlite, ['monitors', 'notification_channels']) },
  { kind: 'data', name: 'action-keys-backfill-v1', run: (sqlite) => backfillKeys(sqlite, ['actions']) },
  /** The built-in template used by automatic incidents; operators may edit it but not delete it. */
  { kind: 'data', name: 'default-incident-template-v1', run(sqlite) {
    const now = Date.now()
    sqlite.prepare(
      'INSERT INTO incident_templates (name, title, body, resolved_body, impact, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    ).run(
      'Default',
      '{{monitor}} is unavailable',
      'We detected that {{monitor}} has been unavailable for {{duration}}. We are investigating.',
      '{{monitor}} is available again. The outage lasted {{duration}}.',
      'major',
      now, now,
    )
  } },
  // After the backfill: before it, every existing row would share the empty default.
  { kind: 'exec', sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_monitors_key ON monitors(key)` },
  { kind: 'exec', sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_channels_key ON notification_channels(key)` },
  { kind: 'exec', sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_key ON actions(key)` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS static_mirror_settings (
  id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  endpoint TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT 'auto',
  bucket TEXT NOT NULL DEFAULT '',
  access_key_id TEXT NOT NULL DEFAULT '',
  secret_access_key TEXT NOT NULL DEFAULT '',
  interval_seconds INTEGER NOT NULL DEFAULT 60,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS static_mirror_status (
  id INTEGER PRIMARY KEY,
  last_run_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  last_uploaded_files INTEGER NOT NULL DEFAULT 0
);
` },
  { kind: 'column', sql: `ALTER TABLE static_mirror_settings ADD COLUMN show_banner INTEGER NOT NULL DEFAULT 1`, desc: 'static_mirror_settings.show_banner' },
  { kind: 'column', sql: `ALTER TABLE static_mirror_status ADD COLUMN copy_files INTEGER`, desc: 'static_mirror_status.copy_files' },
  { kind: 'column', sql: `ALTER TABLE static_mirror_status ADD COLUMN copy_bytes INTEGER`, desc: 'static_mirror_status.copy_bytes' },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS static_mirror_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  uploaded_files INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
` },
  // Counted from every result that exists, in one transaction with the triggers that keep it current, so no result is
  // written between the count and the triggers. On a large database the first start after the upgrade takes a few seconds.
  // Anything that rebuilds monitor_results later must call rebuildDailyResults again (see db/dailyResults.ts).
  { kind: 'data', name: 'monitor-daily-results-v1', run(sqlite) {
    console.log('… Building daily uptime totals')
    rebuildDailyResults(sqlite)
  } },
  // A copy of the database alone must not carry working manage links: the token is stored encrypted and looked up by its hash.
  { kind: 'column', sql: `ALTER TABLE subscribers ADD COLUMN manage_token_hash TEXT`, desc: 'subscribers.manage_token_hash' },
  { kind: 'data', name: 'subscriber-manage-token-hash-v1', run(sqlite) {
    const rows = sqlite.prepare('SELECT id, manage_token FROM subscribers WHERE manage_token_hash IS NULL').all() as { id: number; manage_token: string }[]
    // Without the key the box falls back to a public one, and tokens encrypted with it could never be read again with the real key.
    if (rows.length && !process.env['VAULT_ENCRYPTION_KEY'] && !['test', 'development'].includes(process.env['NODE_ENV'] ?? '')) {
      throw new Error('VAULT_ENCRYPTION_KEY must be set to upgrade the stored subscriber links; set it to the key of this installation and start again')
    }
    const { encrypt } = createSecretBox()
    const update = sqlite.prepare('UPDATE subscribers SET manage_token = ?, manage_token_hash = ? WHERE id = ?')
    for (const row of rows) update.run(encrypt(row.manage_token), createHash('sha256').update(row.manage_token).digest('hex'), row.id)
  } },
  { kind: 'exec', sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_subscribers_manage_token_hash ON subscribers(manage_token_hash)` },
  // Credentials entered straight into a monitor, action or channel (and the SMTP password) were stored in the clear.
  { kind: 'data', name: 'sealed-inline-secrets-v1', run: sealStoredSecrets },
]
