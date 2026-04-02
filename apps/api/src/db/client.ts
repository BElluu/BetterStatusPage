import { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as schema from './schema.js'
import path from 'path'
import fs from 'fs'

const dbPath = process.env['DATABASE_PATH'] ?? './data/db.sqlite'
const dir = path.dirname(dbPath)
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true })
}

export const sqlite = new DatabaseSync(dbPath)
sqlite.exec('PRAGMA journal_mode = WAL')
sqlite.exec('PRAGMA foreign_keys = ON')

// Bridge node:sqlite to drizzle sqlite-proxy (async wrapper)
export const db = drizzle(
  async (sql, params, method) => {
    // node:sqlite only accepts primitive values; cast is safe since Drizzle only passes primitives
    type P = string | number | bigint | null | Uint8Array
    const p = params as P[]
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
  { schema },
)
