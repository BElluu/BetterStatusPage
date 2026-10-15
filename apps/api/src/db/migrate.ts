import { applyColumnMigration as applyColumn, runMigrations as migrate } from '@better-kit/db'
import { sqlite } from './client.js'
import { dbModules } from './modules/index.js'

/** `ALTER TABLE` that tolerates only its own "already applied" error; see the database package. */
export function applyColumnMigration(sql: string): boolean {
  return applyColumn(sqlite, sql)
}

/** Runs all migrations against the already-initialized DB: the shared modules first, then the application's own. */
export function runMigrations(): void {
  migrate(sqlite, dbModules)
}
