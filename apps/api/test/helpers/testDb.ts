import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, initDb } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'

export interface TestDb {
  /** Temporary directory holding the database (and anything else the test puts there). */
  dir: string
  /** Absolute path of the SQLite file; also exported as DATABASE_PATH. */
  dbPath: string
  /** DATABASE_PATH before createTestDb() changed it, restored by teardownTestDb(). */
  previousDatabasePath: string | undefined
}

/**
 * Creates a temp directory and points DATABASE_PATH at a fresh SQLite file inside it.
 * Does not open the database, so call it at module level (or in a hook) before initTestDb().
 */
export function createTestDb(prefix: string, fileName = 'test.sqlite'): TestDb {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const dbPath = join(dir, fileName)
  const previousDatabasePath = process.env['DATABASE_PATH']
  process.env['DATABASE_PATH'] = dbPath
  return { dir, dbPath, previousDatabasePath }
}

/** Opens the database at DATABASE_PATH and applies all migrations. */
export function initTestDb(): void {
  initDb()
  runMigrations()
}

/**
 * Closes the shared handle via closeDb() — a raw sqlite.close() would leave client.ts holding a
 * stale handle that makes the next initDb() a no-op — then restores DATABASE_PATH and removes the directory.
 */
export function teardownTestDb(testDb: TestDb): void {
  closeDb()
  if (testDb.previousDatabasePath === undefined) delete process.env['DATABASE_PATH']
  else process.env['DATABASE_PATH'] = testDb.previousDatabasePath
  rmSync(testDb.dir, { recursive: true, force: true })
}
