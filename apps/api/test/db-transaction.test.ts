import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { db, closeDb, initDb } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { users } from '../src/db/schema.js'
import { withImmediateTransaction } from '../src/db/transaction.js'

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
})
