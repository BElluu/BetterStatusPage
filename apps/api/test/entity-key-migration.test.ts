import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { closeDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { createTestDb, initTestDb, teardownTestDb, type TestDb } from './helpers/testDb.js'

let testDb: TestDb

before(() => {
  testDb = createTestDb('bsp-key-migration-', 'key-migration.sqlite')
  closeDb()
  initTestDb()
})

after(() => {
  teardownTestDb(testDb)
})

const keys = (table: string) => (sqlite.prepare(`SELECT name, key FROM ${table} ORDER BY id`).all() as Array<{ name: string; key: string }>)
  .map((row) => `${row.name}=${row.key}`)
const columns = (table: string) => (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)

/** Puts monitors and notification_channels back into the shape of a database created before keys existed. */
function downgradeToKeyless() {
  sqlite.exec(`
    DROP INDEX idx_monitors_key;
    DROP INDEX idx_notification_channels_key;
    ALTER TABLE monitors DROP COLUMN key;
    ALTER TABLE notification_channels DROP COLUMN key;
    DELETE FROM schema_migrations WHERE name = 'entity-keys-backfill-v1';
  `)
}

describe('upgrading a database that has no entity keys', () => {
  before(() => {
    downgradeToKeyless()
    const monitor = sqlite.prepare('INSERT INTO monitors (name, type, config, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
    for (const name of ['Public API', 'Public API', 'Główna strona', '!!!', 'Edge']) monitor.run(name, 'https', '{}')
    const channel = sqlite.prepare('INSERT INTO notification_channels (name, type, created_at, updated_at) VALUES (?, ?, 1, 1)')
    for (const name of ['Slack', 'Slack', 'On-call e-mail']) channel.run(name, 'webhook')
    assert.equal(columns('monitors').includes('key'), false)
    runMigrations()
  })

  it('gives every existing row a key derived from its name, in id order', () => {
    assert.deepEqual(keys('monitors'), [
      'Public API=public-api', 'Public API=public-api-2', 'Główna strona=glowna-strona', '!!!=item', 'Edge=edge',
    ])
    assert.deepEqual(keys('notification_channels'), ['Slack=slack', 'Slack=slack-2', 'On-call e-mail=on-call-e-mail'])
  })

  it('adds the column last, where the Drizzle schema expects it', () => {
    assert.equal(columns('monitors').at(-1), 'key')
    assert.equal(columns('notification_channels').at(-1), 'key')
  })

  it('enforces uniqueness afterwards', () => {
    assert.throws(() => sqlite.prepare("UPDATE monitors SET key = 'edge' WHERE name = '!!!'").run(), /UNIQUE/)
    assert.throws(() => sqlite.prepare("UPDATE notification_channels SET key = 'slack' WHERE name = 'On-call e-mail'").run(), /UNIQUE/)
  })

  it('leaves keys alone on later starts, even ones an administrator edited', () => {
    sqlite.prepare("UPDATE monitors SET key = 'main-site' WHERE name = 'Główna strona'").run()
    runMigrations()
    runMigrations()
    assert.ok(keys('monitors').includes('Główna strona=main-site'))
    assert.equal(keys('monitors').length, 5)
  })
})

describe('upgrading when some rows already have keys', () => {
  it('does not hand out a key that is taken', () => {
    downgradeToKeyless()
    sqlite.exec('DELETE FROM monitors; DELETE FROM notification_channels;')
    // A database the new version already touched: one row keyed by hand, a same-named one not yet.
    sqlite.exec(`
      ALTER TABLE monitors ADD COLUMN key TEXT NOT NULL DEFAULT '';
      ALTER TABLE notification_channels ADD COLUMN key TEXT NOT NULL DEFAULT '';
      INSERT INTO monitors (name, type, config, created_at, updated_at, key) VALUES ('Taken', 'https', '{}', 1, 1, 'edge');
      INSERT INTO monitors (name, type, config, created_at, updated_at) VALUES ('Edge', 'https', '{}', 1, 1);
    `)
    runMigrations()
    assert.deepEqual(keys('monitors'), ['Taken=edge', 'Edge=edge-2'])
  })
})
