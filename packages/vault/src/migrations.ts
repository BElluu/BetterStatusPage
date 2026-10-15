import type { MigrationStep } from '@better-kit/db'

/** Vaults and the secrets in them. Steps run in this order. */
export const vaultMigrations: readonly MigrationStep[] = [
  { kind: 'exec', sql: `
CREATE TABLE IF NOT EXISTS vaults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'local',
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
` },
  { kind: 'exec', sql: `
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
` },
  { kind: 'column', sql: `ALTER TABLE vaults ADD COLUMN connection_config TEXT`, desc: 'vaults.connection_config' },
]
