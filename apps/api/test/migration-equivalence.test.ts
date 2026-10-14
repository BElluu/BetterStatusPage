import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { closeDb, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { createTestDb, initTestDb, teardownTestDb, type TestDb } from './helpers/testDb.js'

const GOLDEN = fileURLToPath(new URL('./fixtures/schema-0.4.0.json', import.meta.url))

interface SchemaObject { type: string; name: string; table: string; sql: string | null }
interface Golden { objects: SchemaObject[]; migrations: string[] }

/** Everything the schema consists of, and the data migrations recorded as applied (their timestamps are not part of it). */
function snapshot(): Golden {
  const objects = (sqlite.prepare(
    `SELECT type, name, tbl_name AS "table", sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
  ).all() as unknown as SchemaObject[]).map((o) => ({ type: o.type, name: o.name, table: o.table, sql: o.sql }))
  const migrations = (sqlite.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as Array<{ name: string }>).map((r) => r.name)
  return { objects, migrations }
}

let testDb: TestDb
before(() => { testDb = createTestDb('bsp-migration-equivalence-') })
after(() => teardownTestDb(testDb))

// Guards the module extraction (each module will own and register its own migrations): a fresh install and an
// upgrade of an install made by the 0.4.0 release must both end in exactly the schema recorded here, and names of
// applied data migrations must not change, or they would run again on existing data.
// Regenerate deliberately with UPDATE_SNAPSHOTS=1 when the schema changes on purpose.
describe('migrations', () => {
  it('create the recorded schema on an empty database', () => {
    initTestDb()
    const actual = snapshot()
    if (process.env['UPDATE_SNAPSHOTS'] === '1' || !existsSync(GOLDEN)) {
      mkdirSync(join(GOLDEN, '..'), { recursive: true })
      writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n')
    }
    assert.deepEqual(actual, JSON.parse(readFileSync(GOLDEN, 'utf8')))
  })

  it('leave a database from the previous release unchanged', () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden
    closeDb()
    const upgrade = createTestDb('bsp-migration-upgrade-')
    try {
      initDb()
      // Tables before the indexes on them.
      const create = (type: string) => golden.objects.filter((o) => o.type === type && o.sql).forEach((o) => sqlite.exec(o.sql!))
      create('table')
      for (const type of ['index', 'trigger', 'view']) create(type)
      const appliedAt = 1_700_000_000_000
      const record = sqlite.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
      for (const name of golden.migrations) record.run(name, appliedAt)

      runMigrations()

      assert.deepEqual(snapshot(), golden)
      const rows = sqlite.prepare('SELECT applied_at FROM schema_migrations').all() as Array<{ applied_at: number }>
      assert.ok(rows.every((r) => r.applied_at === appliedAt), 'an applied data migration ran again')
    } finally {
      teardownTestDb(upgrade)
    }
  })
})

