import type { DatabaseSync } from 'node:sqlite'

/**
 * One step of a module's migrations. Steps run in the order they are listed, on every start, so each must be
 * idempotent; a `data` step is made so by being recorded in `schema_migrations` under its name.
 */
export type MigrationStep =
  /** Idempotent DDL, such as `CREATE TABLE IF NOT EXISTS`. */
  | { kind: 'exec'; sql: string }
  /**
   * A change that fails when it was already applied (`ADD COLUMN`, `DROP COLUMN`). Only that failure is expected;
   * anything else (typo, locked database, disk full) surfaces.
   */
  | { kind: 'column'; sql: string; desc: string }
  /** Runs once in an immediate transaction. The name is stored: renaming it would run the step again on existing data. */
  | { kind: 'data'; name: string; run(sqlite: DatabaseSync): void }

/** A part of the schema with the migrations that create and evolve it. */
export interface DbModule<Tables extends Record<string, unknown> = Record<string, unknown>> {
  id: string
  /** Drizzle table definitions the module owns. */
  tables: Tables
  migrations: readonly MigrationStep[]
}

const SCHEMA_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`

/**
 * Merges the tables of several modules into one Drizzle schema. A repeated module id, table export or data
 * migration name is a mistake that would silently shadow or double-run something, so it throws.
 */
export function composeModules<const Modules extends readonly DbModule[]>(modules: Modules): {
  schema: Record<string, unknown>
  modules: Modules
} {
  const ids = new Set<string>()
  const dataNames = new Set<string>()
  const schema: Record<string, unknown> = {}
  for (const module of modules) {
    if (ids.has(module.id)) throw new Error(`Duplicate database module "${module.id}"`)
    ids.add(module.id)
    for (const [exportName, table] of Object.entries(module.tables)) {
      if (Object.hasOwn(schema, exportName)) throw new Error(`Duplicate table export "${exportName}" in module "${module.id}"`)
      schema[exportName] = table
    }
    for (const step of module.migrations) {
      if (step.kind !== 'data') continue
      if (dataNames.has(step.name)) throw new Error(`Duplicate data migration "${step.name}" in module "${module.id}"`)
      dataNames.add(step.name)
    }
  }
  return { schema, modules }
}

/**
 * Applies the `column` change in `sql`. Returns true when it changed the schema and false when it had already been
 * applied.
 */
export function applyColumnMigration(sqlite: DatabaseSync, sql: string): boolean {
  const alreadyApplied = /\bADD\s+COLUMN\b/i.test(sql) ? /duplicate column name/i
    : /\bDROP\s+COLUMN\b/i.test(sql) ? /no such column/i
      : null
  try {
    sqlite.exec(sql)
    return true
  } catch (error) {
    if (alreadyApplied && error instanceof Error && alreadyApplied.test(error.message)) return false
    throw error
  }
}

function runDataMigration(sqlite: DatabaseSync, name: string, migrate: () => void): void {
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

/**
 * Brings the database to the schema the modules describe: first the migration ledger, then each module's steps in
 * the order the modules are given. Safe to run on every start.
 */
export function runMigrations(sqlite: DatabaseSync, modules: readonly DbModule[], options: { log?: (message: string) => void } = {}): void {
  const log = options.log ?? console.log
  composeModules(modules)
  sqlite.exec(SCHEMA_MIGRATIONS)
  for (const module of modules) {
    for (const step of module.migrations) {
      if (step.kind === 'exec') sqlite.exec(step.sql)
      else if (step.kind === 'column') { if (applyColumnMigration(sqlite, step.sql)) log(`✓ Column migration: ${step.desc}`) }
      else runDataMigration(sqlite, step.name, () => step.run(sqlite))
    }
  }
  log('✓ Migrations applied')
}
