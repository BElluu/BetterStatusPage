import 'dotenv/config'
import { closeDb, initDb } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'

try {
  initDb()
  runMigrations()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  closeDb()
}
