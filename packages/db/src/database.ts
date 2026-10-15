import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'

/**
 * The Drizzle handle as a package sees it. Which tables it knows is the application's business, so the schema is left
 * open; each package names the tables it uses in its queries.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqliteDatabase = SqliteRemoteDatabase<any>

type Param = string | number | bigint | null | Uint8Array

export interface Database<Schema extends Record<string, unknown>> {
  /** Raw node:sqlite handle. */
  sqlite: DatabaseSync
  /** Drizzle handle over the same connection. */
  db: SqliteRemoteDatabase<Schema>
  close(): void
}

/**
 * Opens (creating its directory when needed) the SQLite file at `path` in WAL mode with foreign keys on, and wires
 * Drizzle to the same connection. A process uses one connection; the caller decides where that instance lives.
 */
export function openDatabase<Schema extends Record<string, unknown>>(options: { path: string; schema: Schema }): Database<Schema> {
  const dir = path.dirname(options.path)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const sqlite = new DatabaseSync(options.path)
  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA foreign_keys = ON')
  // sqlite-proxy maps result rows by position, so rows are handed over as value arrays.
  const db = drizzle(
    async (sql, params, method) => {
      const p = params as Param[]
      const stmt = sqlite.prepare(sql)
      if (method === 'run') {
        stmt.run(...p)
        return { rows: [] }
      } else if (method === 'get') {
        const row = stmt.get(...p) as Record<string, unknown> | undefined
        return { rows: row ? [Object.values(row)] : [] }
      } else {
        const rows = stmt.all(...p) as Record<string, unknown>[]
        return { rows: rows.map((r) => Object.values(r)) }
      }
    },
    { schema: options.schema },
  )
  return { sqlite, db, close: () => sqlite.close() }
}
