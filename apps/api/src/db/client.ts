import type { DatabaseSync } from 'node:sqlite'
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import { openDatabase, type Database } from '@better-forge/db'
import * as schema from './schema.js'
import { databasePath } from '../config.js'

type DrizzleDb = SqliteRemoteDatabase<typeof schema>

// The process-wide connection lives here, in the application: the database package has no state of its own.
let _database: Database<typeof schema> | null = null

/** Call once — opens the SQLite file and wires up Drizzle. */
export function initDb(): void {
  if (_database) return
  _database = openDatabase({ path: databasePath(), schema })
}

export function closeDb(): void {
  _database?.close()
  _database = null
}

/** Raw node:sqlite handle — only accessible after initDb(). */
export const sqlite: DatabaseSync = new Proxy({} as DatabaseSync, {
  get(_, prop) {
    if (!_database) throw new Error('DB not initialized — call initDb() first')
    const value = Reflect.get(_database.sqlite, prop, _database.sqlite)
    return typeof value === 'function' ? value.bind(_database.sqlite) : value
  },
})

/** Drizzle ORM handle — only accessible after initDb(). */
export const db: DrizzleDb = new Proxy({} as DrizzleDb, {
  get(_, prop) {
    if (!_database) throw new Error('DB not initialized — call initDb() first')
    const value = Reflect.get(_database.db, prop, _database.db)
    return typeof value === 'function' ? value.bind(_database.db) : value
  },
})
