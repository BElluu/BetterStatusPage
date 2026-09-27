import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { closeDb, sqlite } from '../src/db/client.js'
import { applyColumnMigration, runMigrations } from '../src/db/migrate.js'
import * as schema from '../src/db/schema.js'
import { createTestDb, initTestDb, teardownTestDb, type TestDb } from './helpers/testDb.js'

let testDb: TestDb

before(() => {
  testDb = createTestDb('bsp-schema-test-', 'schema.sqlite')
  closeDb()
  initTestDb()
})

after(() => {
  teardownTestDb(testDb)
})

const tables = Object.values(schema).filter((value): value is SQLiteTable => value instanceof SQLiteTable)

describe('column migrations', () => {
  it('are idempotent across restarts', () => {
    assert.doesNotThrow(() => runMigrations())
  })

  it('skip only already-applied columns and surface every other error', () => {
    assert.equal(applyColumnMigration('ALTER TABLE users ADD COLUMN totp_secret TEXT'), false)
    assert.equal(applyColumnMigration('ALTER TABLE monitors DROP COLUMN group_id'), false)
    assert.throws(() => applyColumnMigration('ALTER TABLE missing_table ADD COLUMN extra TEXT'), /no such table/)
    assert.throws(() => applyColumnMigration('ALTER TABLE users ADD COLUMN broken TEXT UNIQUE'), /UNIQUE/)
    assert.throws(() => applyColumnMigration('CREATE INDEX IF NOT EXISTS idx_bad ON users(no_such_column)'), /no such column/)
    assert.equal(applyColumnMigration('ALTER TABLE layout ADD COLUMN scratch_note TEXT'), true)
    sqlite.exec('ALTER TABLE layout DROP COLUMN scratch_note')
  })
})

describe('Drizzle schema matches migrated SQLite schema', () => {
  it('covers every table', () => {
    assert.ok(tables.length > 0)
  })

  // sqlite-proxy maps result rows by position, so both names and order must agree.
  for (const table of tables) {
    const config = getTableConfig(table)
    it(`${config.name}: columns match by name and order`, () => {
      const actual = (sqlite.prepare(`PRAGMA table_info(${JSON.stringify(config.name)})`).all() as Array<{ name: string }>).map((c) => c.name)
      assert.ok(actual.length > 0, `table ${config.name} was not created by migrations`)
      assert.deepEqual(actual, config.columns.map((c) => c.name))
    })
  }
})
