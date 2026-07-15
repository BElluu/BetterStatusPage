import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { db, closeDb, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { authSessions, users } from '../src/db/schema.js'
import { withImmediateTransaction } from '../src/db/transaction.js'
import { resetTwoFactor } from '../src/services/twoFactor.js'
import { eq } from 'drizzle-orm'

describe('database transaction helper', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsp-transaction-test-'))
  const previousDatabasePath = process.env['DATABASE_PATH']

  before(() => {
    process.env['DATABASE_PATH'] = join(dir, 'transaction.sqlite')
    initDb()
    runMigrations()
  })

  after(() => {
    closeDb()
    if (previousDatabasePath === undefined) delete process.env['DATABASE_PATH']
    else process.env['DATABASE_PATH'] = previousDatabasePath
    rmSync(dir, { recursive: true, force: true })
  })

  it('rolls back partial setup data when a later operation fails', async () => {
    await assert.rejects(withImmediateTransaction(async () => {
      await db.insert(users).values({
        email: 'partial@example.test', passwordHash: 'hash', role: 'admin', createdAt: Date.now(),
      })
      throw new Error('simulated setup failure')
    }), /simulated setup failure/)

    assert.equal((await db.select().from(users)).length, 0)
  })

  it('keeps 2FA enabled when session revocation fails', async () => {
    const [user] = await db.insert(users).values({
      email: 'rollback-2fa@example.test', passwordHash: 'hash', role: 'admin', createdAt: Date.now(),
      totpEnabled: 1, totpSecret: 'encrypted-secret', totpRecoveryCodes: '["hashed-code"]',
    }).returning()
    await db.insert(authSessions).values({
      id: 'rollback-session', userId: user!.id, csrfTokenHash: 'hash',
      createdAt: Date.now(), lastSeenAt: Date.now(), expiresAt: Date.now() + 60_000,
    })
    sqlite.exec(`
      CREATE TRIGGER reject_session_delete
      BEFORE DELETE ON auth_sessions
      BEGIN
        SELECT RAISE(ABORT, 'simulated session delete failure');
      END
    `)

    try {
      await assert.rejects(resetTwoFactor(user!.id), /Failed query: delete from "auth_sessions"/)
    } finally {
      sqlite.exec('DROP TRIGGER reject_session_delete')
    }

    const unchanged = (await db.select().from(users).where(eq(users.id, user!.id)))[0]!
    assert.equal(unchanged.totpEnabled, 1)
    assert.equal(unchanged.totpSecret, 'encrypted-secret')
    assert.equal(unchanged.totpRecoveryCodes, '["hashed-code"]')
    assert.equal((await db.select().from(authSessions).where(eq(authSessions.userId, user!.id))).length, 1)
  })
})
