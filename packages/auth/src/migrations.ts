import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { MigrationStep } from '@better-forge/db'

/** Users, sign-in sessions, SSO settings and API tokens. Steps run in this order. */
export const authMigrations: readonly MigrationStep[] = [
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL
);
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS oidc_settings (
  id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  issuer TEXT NOT NULL DEFAULT '',
  client_id TEXT NOT NULL DEFAULT '',
  client_secret TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT '',
  redirect_uri TEXT NOT NULL DEFAULT '',
  button_label TEXT NOT NULL DEFAULT '',
  allow_unverified_email INTEGER NOT NULL DEFAULT 0,
  disable_password_login INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  csrf_token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  auth_method TEXT NOT NULL DEFAULT 'password',
  verified_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
` },
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  scopes TEXT NOT NULL
);
` },
  { kind: 'column', sql: `ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`, desc: 'users.must_change_password' },
  { kind: 'column', sql: `ALTER TABLE users ADD COLUMN totp_secret TEXT`, desc: 'users.totp_secret' },
  { kind: 'column', sql: `ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`, desc: 'users.totp_enabled' },
  { kind: 'column', sql: `ALTER TABLE users ADD COLUMN totp_recovery_codes TEXT`, desc: 'users.totp_recovery_codes' },
  { kind: 'column', sql: `ALTER TABLE auth_sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password'`, desc: 'auth_sessions.auth_method' },
  { kind: 'column', sql: `ALTER TABLE users ADD COLUMN oidc_issuer TEXT`, desc: 'users.oidc_issuer' },
  { kind: 'column', sql: `ALTER TABLE users ADD COLUMN oidc_subject TEXT`, desc: 'users.oidc_subject' },
  { kind: 'column', sql: `ALTER TABLE auth_sessions ADD COLUMN verified_at INTEGER`, desc: 'auth_sessions.verified_at' },
  // One IdP identity can be bound to one user only. Needs the columns added above.
  { kind: 'exec', sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc_identity ON users(oidc_issuer, oidc_subject)` },
  /**
   * Accounts linked to SSO before a sign-in started revoking the temporary password may still have a working one
   * that their administrator knows. Linking only happens on an SSO sign-in, so revoke it the same way.
   */
  { kind: 'data', name: 'sso-users-temporary-password-revoked-v1', run(sqlite) {
    const pending = sqlite.prepare('SELECT id FROM users WHERE must_change_password = 1 AND oidc_subject IS NOT NULL').all() as Array<{ id: number }>
    const revoke = sqlite.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    for (const { id } of pending) revoke.run(bcrypt.hashSync(randomBytes(32).toString('base64url'), 10), id)
  } },
]
