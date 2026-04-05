import { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as schema from './schema.js'
import path from 'path'
import fs from 'fs'

type DrizzleDb = ReturnType<typeof buildDrizzle>
type P = string | number | bigint | null | Uint8Array

let _sqlite: DatabaseSync | null = null
let _db: DrizzleDb | null = null

function buildDrizzle(raw: DatabaseSync): DrizzleDb {
  return drizzle(
    async (sql, params, method) => {
      const p = params as P[]
      const stmt = raw.prepare(sql)
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
    { schema },
  )
}

/** Call once — opens the SQLite file and wires up Drizzle. */
export function initDb(): void {
  if (_sqlite) return
  const dbPath = process.env['DATABASE_PATH'] ?? './data/db.sqlite'
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  _sqlite = new DatabaseSync(dbPath)
  _sqlite.exec('PRAGMA journal_mode = WAL')
  _sqlite.exec('PRAGMA foreign_keys = ON')
  _db = buildDrizzle(_sqlite)
}

/** Raw node:sqlite handle — only accessible after initDb(). */
export const sqlite: DatabaseSync = new Proxy({} as DatabaseSync, {
  get(_, prop) {
    if (!_sqlite) throw new Error('DB not initialized — call initDb() first')
    const value = Reflect.get(_sqlite, prop, _sqlite)
    return typeof value === 'function' ? (value as Function).bind(_sqlite) : value
  },
})

/** Drizzle ORM handle — only accessible after initDb(). */
export const db: DrizzleDb = new Proxy({} as DrizzleDb, {
  get(_, prop) {
    if (!_db) throw new Error('DB not initialized — call initDb() first')
    const value = Reflect.get(_db, prop, _db)
    return typeof value === 'function' ? (value as Function).bind(_db) : value
  },
})
