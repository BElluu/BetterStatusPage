import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { requireAuth, requireRole } from '../src/middleware/auth.js'
import { authSessions, users } from '../src/db/schema.js'
import { db, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'

const app = Fastify({ logger: false })
const dataDir = mkdtempSync(join(tmpdir(), 'bsp-rbac-test-'))
process.env['DATABASE_PATH'] = join(dataDir, 'test.sqlite')
const authorizations: Record<string, { authorization: string }> = {}

before(async () => {
  initDb()
  runMigrations()
  await app.register(jwt, { secret: 'test-secret-with-sufficient-entropy' })
  app.get('/authenticated', { preHandler: requireAuth }, async () => ({ ok: true }))
  app.get('/operator', { preHandler: requireRole('operator') }, async () => ({ ok: true }))
  app.get('/branding', { preHandler: requireRole('operator', 'branding') }, async () => ({ ok: true }))
  app.get('/admin', { preHandler: requireRole() }, async () => ({ ok: true }))
  await app.ready()
  for (const role of ['admin', 'operator', 'branding']) {
    const [user] = await db.insert(users).values({ email: `${role}@example.test`, passwordHash: 'unused', role, createdAt: Date.now() }).returning()
    const sessionId = `session-${role}`
    const now = Date.now()
    await db.insert(authSessions).values({ id: sessionId, userId: user!.id, csrfTokenHash: 'unused', createdAt: now, lastSeenAt: now, expiresAt: now + 60_000 })
    const token = app.jwt.sign({ userId: user!.id, email: user!.email, role, sessionId })
    authorizations[role] = { authorization: `Bearer ${token}` }
  }
})

after(async () => {
  await app.close()
  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})

function authorization(role: string) {
  return authorizations[role]!
}

describe('JWT and RBAC middleware', () => {
  it('rejects missing and manipulated tokens', async () => {
    assert.equal((await app.inject({ url: '/authenticated' })).statusCode, 401)
    assert.equal((await app.inject({ url: '/authenticated', headers: { authorization: 'Bearer invalid' } })).statusCode, 401)
  })

  it('allows any valid token through authentication', async () => {
    assert.equal((await app.inject({ url: '/authenticated', headers: authorization('branding') })).statusCode, 200)
  })

  it('enforces role boundaries and admin inheritance', async () => {
    assert.equal((await app.inject({ url: '/operator', headers: authorization('branding') })).statusCode, 403)
    assert.equal((await app.inject({ url: '/operator', headers: authorization('operator') })).statusCode, 200)
    assert.equal((await app.inject({ url: '/branding', headers: authorization('branding') })).statusCode, 200)
    assert.equal((await app.inject({ url: '/admin', headers: authorization('operator') })).statusCode, 403)
    assert.equal((await app.inject({ url: '/admin', headers: authorization('admin') })).statusCode, 200)
  })
})
