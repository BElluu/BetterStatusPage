import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { API_TOKEN_SCOPES } from '@bsp/shared'
import { closeDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { parseScopes } from '../src/services/apiTokens.js'
import { createTestDb, initTestDb, teardownTestDb, type TestDb } from './helpers/testDb.js'

let testDb: TestDb

before(() => {
  testDb = createTestDb('bsp-token-migration-', 'token-migration.sqlite')
  closeDb()
  initTestDb()
})

after(() => {
  teardownTestDb(testDb)
})

const columns = () => (sqlite.prepare('PRAGMA table_info(api_tokens)').all() as Array<{ name: string }>).map((c) => c.name)
const scopesOf = (name: string) => parseScopes((sqlite.prepare('SELECT scopes FROM api_tokens WHERE name = ?').get(name) as { scopes: string }).scopes)

describe('upgrading tokens that carry a role', () => {
  before(() => {
    // The table as it was when a token had a role and no permissions.
    sqlite.exec(`
      DROP TABLE api_tokens;
      CREATE TABLE api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
        role TEXT NOT NULL, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, last_used_at INTEGER
      );
    `)
    sqlite.prepare("INSERT INTO users (id, email, password_hash, role, created_at) VALUES (1, 'owner@example.test', 'x', 'admin', 1) ON CONFLICT DO NOTHING").run()
    const insert = sqlite.prepare('INSERT INTO api_tokens (name, token_hash, prefix, role, user_id, created_at) VALUES (?, ?, ?, ?, 1, 1)')
    for (const role of ['admin', 'operator', 'branding', 'mystery']) insert.run(role, `hash-${role}`, 'bsp_x', role)
    runMigrations()
  })

  it('replaces the role column with the permissions, last, where a new database has them', () => {
    assert.equal(columns().includes('role'), false)
    assert.equal(columns().at(-1), 'scopes')
  })

  it('gives an admin token every permission', () => {
    assert.deepEqual(scopesOf('admin'), [...API_TOKEN_SCOPES])
  })

  it('gives an operator token everything except the audit log and system health', () => {
    const scopes = scopesOf('operator')
    assert.deepEqual(scopes, API_TOKEN_SCOPES.filter((scope) => !scope.startsWith('audit:') && !scope.startsWith('system:')))
    assert.ok(scopes.includes('monitors:write') && scopes.includes('vault:use'))
    assert.equal(scopes.some((scope) => scope.startsWith('audit:') || scope.startsWith('system:')), false)
  })

  it('gives a branding token the appearance permissions only', () => {
    assert.deepEqual(scopesOf('branding'), ['appearance:read', 'appearance:write'])
  })

  it('gives a token with a role it does not know nothing, rather than guessing', () => {
    assert.deepEqual(scopesOf('mystery'), [])
  })

  it('does nothing when run again', () => {
    const before = JSON.stringify(sqlite.prepare('SELECT * FROM api_tokens ORDER BY id').all())
    runMigrations()
    assert.equal(JSON.stringify(sqlite.prepare('SELECT * FROM api_tokens ORDER BY id').all()), before)
  })
})
