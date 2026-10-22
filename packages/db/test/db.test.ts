import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { composeModules, openDatabase, runMigrations, applyColumnMigration, withImmediateTransaction, type DbModule } from '@better-kit/db'

const notes = sqliteTable('notes', { id: integer('id').primaryKey({ autoIncrement: true }), body: text('body').notNull() })
const tags = sqliteTable('tags', { id: integer('id').primaryKey({ autoIncrement: true }), noteId: integer('note_id').notNull() })

const base: DbModule = {
  id: 'base',
  tables: { notes },
  migrations: [
    { kind: 'exec', sql: 'CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)' },
    { kind: 'column', sql: 'ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0', desc: 'notes.pinned' },
    { kind: 'data', name: 'seed-first-note-v1', run: (sqlite) => { sqlite.exec(`INSERT INTO notes (body) VALUES ('first')`) } },
  ],
}
const extra: DbModule = {
  id: 'extra',
  tables: { tags },
  migrations: [{ kind: 'exec', sql: 'CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER NOT NULL)' }],
}

/** node:sqlite rows have no prototype, which strict deepEqual tells apart from plain objects. */
const rows = (all: unknown[]) => all.map((row) => ({ ...(row as object) }))

describe('composeModules', () => {
  it('merges the tables of every module', () => {
    assert.deepEqual(Object.keys(composeModules([base, extra]).schema), ['notes', 'tags'])
  })

  it('refuses a repeated module, table export or data migration name', () => {
    assert.throws(() => composeModules([base, base]), /Duplicate database module "base"/)
    assert.throws(() => composeModules([base, { ...extra, tables: { notes } }]), /Duplicate table export "notes"/)
    const sameName: DbModule = { id: 'other', tables: {}, migrations: [{ kind: 'data', name: 'seed-first-note-v1', run: () => undefined }] }
    assert.throws(() => composeModules([base, sameName]), /Duplicate data migration "seed-first-note-v1"/)
  })
})

describe('runMigrations', () => {
  const memory = () => new DatabaseSync(':memory:')

  it('runs the steps of the modules in order, once, however often it is called', () => {
    const sqlite = memory()
    const log: string[] = []
    runMigrations(sqlite, [base, extra], { log: (m) => log.push(m) })
    runMigrations(sqlite, [base, extra], { log: (m) => log.push(m) })
    assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number }).n, 1)
    assert.deepEqual(rows(sqlite.prepare('SELECT name FROM schema_migrations').all()), [{ name: 'seed-first-note-v1' }])
    assert.equal(log.filter((m) => m.includes('Column migration: notes.pinned')).length, 1)
    assert.equal(log.filter((m) => m === '✓ Migrations applied').length, 2)
  })

  it('rolls a failing data step back and leaves it unrecorded', () => {
    const sqlite = memory()
    const failing: DbModule = {
      id: 'failing', tables: {},
      migrations: [
        { kind: 'exec', sql: 'CREATE TABLE IF NOT EXISTS t (v TEXT)' },
        { kind: 'data', name: 'half-done-v1', run: (db) => { db.exec(`INSERT INTO t VALUES ('x')`); throw new Error('boom') } },
      ],
    }
    assert.throws(() => runMigrations(sqlite, [failing], { log: () => undefined }), /boom/)
    assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n, 0)
    assert.equal(sqlite.prepare('SELECT 1 FROM schema_migrations').get(), undefined)
  })
})

describe('applyColumnMigration', () => {
  it('skips only a change that was already applied and surfaces every other error', () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('CREATE TABLE t (a TEXT)')
    assert.equal(applyColumnMigration(sqlite, 'ALTER TABLE t ADD COLUMN b TEXT'), true)
    assert.equal(applyColumnMigration(sqlite, 'ALTER TABLE t ADD COLUMN b TEXT'), false)
    assert.equal(applyColumnMigration(sqlite, 'ALTER TABLE t DROP COLUMN b'), true)
    assert.equal(applyColumnMigration(sqlite, 'ALTER TABLE t DROP COLUMN b'), false)
    assert.throws(() => applyColumnMigration(sqlite, 'ALTER TABLE missing ADD COLUMN x TEXT'), /no such table/)
  })
})

describe('withImmediateTransaction', () => {
  it('commits on success and rolls back when the work throws', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('CREATE TABLE t (v TEXT)')
    await withImmediateTransaction(sqlite, async () => { sqlite.exec(`INSERT INTO t VALUES ('kept')`) })
    await assert.rejects(withImmediateTransaction(sqlite, async () => { sqlite.exec(`INSERT INTO t VALUES ('lost')`); throw new Error('nope') }), /nope/)
    assert.deepEqual(rows(sqlite.prepare('SELECT v FROM t').all()), [{ v: 'kept' }])
  })

  it('lets transactions started at the same time take turns, whatever happens to the earlier ones', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('CREATE TABLE t (v TEXT)')
    const insert = (value: string, fail = false) => withImmediateTransaction(sqlite, async () => {
      sqlite.exec(`INSERT INTO t VALUES ('${value}')`)
      await Promise.resolve()
      if (fail) throw new Error(`${value} failed`)
    })

    const results = await Promise.allSettled([insert('a'), insert('b', true), insert('c'), insert('d')])

    assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled'])
    assert.deepEqual(rows(sqlite.prepare('SELECT v FROM t ORDER BY rowid').all()), [{ v: 'a' }, { v: 'c' }, { v: 'd' }])
  })

  it('refuses a transaction started inside another instead of waiting for it forever', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('CREATE TABLE t (v TEXT)')
    await assert.rejects(withImmediateTransaction(sqlite, async () => {
      sqlite.exec(`INSERT INTO t VALUES ('outer')`)
      await withImmediateTransaction(sqlite, async () => { sqlite.exec(`INSERT INTO t VALUES ('inner')`) })
    }), /Nested transaction/)
    assert.deepEqual(rows(sqlite.prepare('SELECT v FROM t').all()), [])
    // The connection is usable afterwards.
    await withImmediateTransaction(sqlite, async () => { sqlite.exec(`INSERT INTO t VALUES ('later')`) })
    assert.deepEqual(rows(sqlite.prepare('SELECT v FROM t').all()), [{ v: 'later' }])
  })
})

describe('openDatabase', () => {
  it('creates the directory, enables foreign keys and serves Drizzle over the same connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-db-'))
    const database = openDatabase({ path: join(dir, 'nested', 'db.sqlite'), schema: { notes } })
    try {
      assert.equal((database.sqlite.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1)
      database.sqlite.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)')
      await database.db.insert(notes).values({ body: 'hello' })
      assert.deepEqual(await database.db.select().from(notes), [{ id: 1, body: 'hello' }])
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
