import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { db, closeDb, initDb } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { auditLog, authSessions, users } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'

const dataDir = mkdtempSync(join(tmpdir(), 'bsp-2fa-cli-test-'))
const databasePath = join(dataDir, 'test.sqlite')
process.env['DATABASE_PATH'] = databasePath

after(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('emergency 2FA reset CLI', () => {
  it('requires exact confirmation, clears 2FA, revokes sessions, and writes an audit entry', async () => {
    initDb()
    runMigrations()
    const [user] = await db.insert(users).values({
      email: 'locked-admin@example.test', passwordHash: 'unused', role: 'admin', createdAt: Date.now(),
      totpEnabled: 1, totpSecret: 'encrypted-secret', totpRecoveryCodes: '["hashed-code"]',
    }).returning()
    await db.insert(authSessions).values({
      id: 'locked-session', userId: user!.id, csrfTokenHash: 'hash',
      createdAt: Date.now(), lastSeenAt: Date.now(), expiresAt: Date.now() + 60_000,
    })
    closeDb()

    const script = join(process.cwd(), 'apps/api/src/cli/resetTwoFactor.ts')
    const environment = { ...process.env, DATABASE_PATH: databasePath }
    const rejected = spawnSync(process.execPath, ['--import', 'tsx', script, '--email', user!.email, '--confirm', 'wrong@example.test'], { env: environment, encoding: 'utf8' })
    assert.equal(rejected.status, 1)
    assert.match(rejected.stderr, /Usage: 2fa:reset/)

    const result = spawnSync(process.execPath, ['--import', 'tsx', script, '--email', user!.email, '--confirm', user!.email], { env: environment, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /All active sessions were revoked/)

    initDb()
    const updated = (await db.select().from(users).where(eq(users.id, user!.id)))[0]!
    assert.equal(updated.totpEnabled, 0)
    assert.equal(updated.totpSecret, null)
    assert.equal(updated.totpRecoveryCodes, null)
    assert.equal((await db.select().from(authSessions).where(eq(authSessions.userId, user!.id))).length, 0)
    const entries = await db.select().from(auditLog).where(eq(auditLog.entityId, String(user!.id)))
    assert.equal(entries.some((entry) => entry.userEmail === 'system:cli' && entry.diff?.includes('emergency_cli')), true)
  })
})
