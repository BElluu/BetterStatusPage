import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { closeDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { decrypt } from '../src/kit/secretBox.js'
import { hashToken } from '../src/services/subscriptions.js'
import { createTestDb, initTestDb, teardownTestDb, type TestDb } from './helpers/testDb.js'

let testDb: TestDb
const originalMode = process.env['NODE_ENV']

before(() => {
  process.env['NODE_ENV'] = 'test'
  testDb = createTestDb('bsp-token-migration-', 'token-migration.sqlite')
  closeDb()
  initTestDb()
})

after(() => {
  if (originalMode === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = originalMode
  teardownTestDb(testDb)
})

describe('upgrading a database that keeps manage tokens in the clear', () => {
  before(() => {
    sqlite.exec(`
      DROP INDEX idx_subscribers_manage_token_hash;
      ALTER TABLE subscribers DROP COLUMN manage_token_hash;
      DELETE FROM schema_migrations WHERE name = 'subscriber-manage-token-hash-v1';
    `)
    const insert = sqlite.prepare(
      `INSERT INTO subscribers (type, target_key, email, manage_token, created_at, updated_at) VALUES ('email', ?, ?, ?, 1, 1)`,
    )
    insert.run('email:a@example.test', 'a@example.test', 'plain-token-a')
    insert.run('email:b@example.test', 'b@example.test', 'plain-token-b')
    runMigrations()
  })

  it('encrypts each token and keeps the hash the links are looked up by', () => {
    const rows = sqlite.prepare('SELECT manage_token, manage_token_hash FROM subscribers ORDER BY id').all() as Array<{ manage_token: string; manage_token_hash: string }>
    assert.deepEqual(rows.map((row) => decrypt(row.manage_token)), ['plain-token-a', 'plain-token-b'])
    assert.deepEqual(rows.map((row) => row.manage_token_hash), [hashToken('plain-token-a'), hashToken('plain-token-b')])
    assert.ok(rows.every((row) => !row.manage_token.startsWith('plain-token')))
  })

  it('refuses to encrypt with the development key outside development and test', () => {
    sqlite.exec(`
      DELETE FROM schema_migrations WHERE name = 'subscriber-manage-token-hash-v1';
      INSERT INTO subscribers (type, target_key, email, manage_token, created_at, updated_at) VALUES ('email', 'email:c@example.test', 'c@example.test', 'plain-token-c', 1, 1);
    `)
    const env = { key: process.env['VAULT_ENCRYPTION_KEY'], mode: process.env['NODE_ENV'] }
    delete process.env['VAULT_ENCRYPTION_KEY']
    process.env['NODE_ENV'] = 'production'
    try {
      assert.throws(() => runMigrations(), /VAULT_ENCRYPTION_KEY/)
    } finally {
      if (env.key === undefined) delete process.env['VAULT_ENCRYPTION_KEY']; else process.env['VAULT_ENCRYPTION_KEY'] = env.key
      if (env.mode === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = env.mode
    }
    const [row] = sqlite.prepare("SELECT manage_token FROM subscribers WHERE email = 'c@example.test'").all() as Array<{ manage_token: string }>
    assert.equal(row!.manage_token, 'plain-token-c')
    runMigrations()
  })

  it('does not encrypt twice when the migrations run again', () => {
    runMigrations()
    const [row] = sqlite.prepare('SELECT manage_token FROM subscribers ORDER BY id').all() as Array<{ manage_token: string }>
    assert.equal(decrypt(row!.manage_token), 'plain-token-a')
  })
})
