import type { DatabaseSync } from 'node:sqlite'
import { auditDbModule } from '@better-kit/audit'
import { authDbModule } from '@better-kit/auth'
import { randomEntityKey } from '@better-kit/config-as-code'
import { composeModules, openDatabase, runMigrations, type Database, type DbModule, type SqliteDatabase } from '@better-kit/db'
import { createNotifyDbModule } from '@better-kit/notify'
import { databasePath } from '@better-kit/runtime'
import { vaultDbModule } from '@better-kit/vault'

/** What the notifications are about is called a source here; the template has no monitors or pages of its own. */
export const notifyModule = createNotifyDbModule({
  sourceIdColumn: 'source_id',
  sourceNameColumn: 'source_name',
  smtpFromName: 'Template Alerts',
  newKey: randomEntityKey,
})

/** In the order they run: a module may rely on the tables of the ones before it. */
const modules: readonly DbModule[] = [authDbModule, auditDbModule, vaultDbModule, notifyModule]
const { schema } = composeModules(modules)

// The process-wide connection lives here, in the application: the database package has no state of its own.
let database: Database<Record<string, unknown>> | null = null

/** Opens the SQLite file and wires up Drizzle. Does nothing if it is open. */
export function initDb(): void {
  if (!database) database = openDatabase({ path: databasePath(), schema })
}

export function closeDb(): void {
  database?.close()
  database = null
}

/** Brings the tables of every module up to date. */
export function migrate(): void {
  runMigrations(sqlite, modules)
}

function lazy<T extends object>(pick: (opened: Database<Record<string, unknown>>) => T): T {
  return new Proxy({} as T, {
    get(_, prop) {
      if (!database) throw new Error('DB not initialized — call initDb() first')
      const target = pick(database)
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** The raw connection, usable once the database is open. */
export const sqlite: DatabaseSync = lazy((opened) => opened.sqlite)

/** The Drizzle handle, usable once the database is open. */
export const db: SqliteDatabase = lazy((opened) => opened.db)
