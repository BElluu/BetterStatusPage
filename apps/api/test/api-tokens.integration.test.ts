import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify, { type RouteOptions } from 'fastify'
import jwt from '@fastify/jwt'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import { and, eq } from 'drizzle-orm'
import { adminApi } from '../src/adminApi.js'
import { db } from '../src/db/client.js'
import { apiTokens, auditLog, authSessions, users } from '../src/db/schema.js'
import { requireAuth } from '../src/middleware/auth.js'
import { consumeApiTokenBudget, hashApiToken, resetApiTokenBudgets } from '../src/services/apiTokens.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-api-tokens-')
process.env['UPLOAD_DIR'] = join(testDb.dir, 'uploads')
const app = Fastify({ logger: false })
const sessions: Record<string, { authorization: string }> = {}
const registeredRoutes: RouteOptions[] = []
let adminId = 0

// The real admin tree from adminApi.ts, so a route group that is moved or added is checked, not a copy of it.
before(async () => {
  initTestDb()
  // Keep the options object: scope hooks rewrite `config` on it after this hook has run.
  app.addHook('onRoute', (route) => { registeredRoutes.push(route) })
  await app.register(cookie)
  await app.register(jwt, { secret: 'test-secret-with-sufficient-entropy' })
  await app.register(multipart)
  await app.register(adminApi, { prefix: '/admin' })
  // Outside the admin scope, like /auth/change-password: never reachable with a token.
  app.get('/auth/session', { preHandler: requireAuth }, async () => ({ ok: true }))
  await app.ready()

  for (const role of ['admin', 'operator'] as const) {
    const now = Date.now()
    const [user] = await db.insert(users).values({ email: `${role}@example.test`, passwordHash: 'unused', role, createdAt: now }).returning()
    const sessionId = `session-${role}`
    await db.insert(authSessions).values({ id: sessionId, userId: user!.id, csrfTokenHash: 'unused', createdAt: now, lastSeenAt: now, expiresAt: now + 60_000 })
    sessions[role] = { authorization: `Bearer ${app.jwt.sign({ userId: user!.id, email: user!.email, role, sessionId })}` }
    if (role === 'admin') adminId = user!.id
  }
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

beforeEach(() => resetApiTokenBudgets())

async function createToken(payload: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: 'POST', url: '/admin/api-tokens', headers: sessions['admin']!,
    payload: { name: 'CI', role: 'operator', ...payload },
  })
  return { response, body: response.json() as { id: number; token: string; prefix: string; role: string; expiresAt: number | null } }
}

const withToken = (token: string) => ({ authorization: `Bearer ${token}` })
const get = (url: string, token: string) => app.inject({ url, headers: withToken(token) })

describe('which admin routes accept a token', () => {
  const SESSION_ONLY = ['/admin/users', '/admin/oidc', '/admin/status-page-access', '/admin/backups', '/admin/api-tokens']
  const TOKEN_ALLOWED = ['/admin/monitors', '/admin/incidents', '/admin/notifications', '/admin/layout', '/admin/maintenance', '/admin/audit', '/admin/system-health']

  const under = (prefix: string) => registeredRoutes.filter((route) => route.url === prefix || route.url.startsWith(`${prefix}/`))

  it('decides explicitly for every admin route', () => {
    const admin = registeredRoutes.filter((route) => route.url.startsWith('/admin'))
    assert.ok(admin.length > 50)
    for (const route of admin) assert.equal(typeof route.config?.allowApiToken, 'boolean', `${String(route.method)} ${route.url}`)
  })

  it('keeps accounts, sign-in, who may view the page, backups and tokens for sessions', () => {
    for (const prefix of SESSION_ONLY) {
      const routes = under(prefix)
      assert.ok(routes.length > 0, prefix)
      for (const route of routes) assert.equal(route.config?.allowApiToken, false, `${String(route.method)} ${route.url}`)
    }
    // Vault management is session only; the catalogue (names and types, for the monitor form) is not.
    const vaults = under('/admin/vaults')
    assert.ok(vaults.some((route) => route.config?.allowApiToken === false))
    assert.ok(vaults.some((route) => route.config?.allowApiToken === true))
  })

  it('lets the rest of the admin API through', () => {
    for (const prefix of TOKEN_ALLOWED) {
      const routes = under(prefix)
      assert.ok(routes.length > 0, prefix)
      for (const route of routes) assert.equal(route.config?.allowApiToken, true, `${String(route.method)} ${route.url}`)
    }
  })
})

describe('creating and listing tokens', () => {
  it('shows the plaintext once and stores only its hash', async () => {
    const { response, body } = await createToken({ name: '  Deploy pipeline  ' })
    assert.equal(response.statusCode, 200)
    assert.match(body.token, /^bsp_[A-Za-z0-9_-]{43}$/)
    assert.equal(body.prefix, body.token.slice(0, 10))
    const stored = (await db.select().from(apiTokens).where(eq(apiTokens.id, body.id)))[0]!
    assert.equal(stored.name, 'Deploy pipeline')
    assert.equal(stored.tokenHash, hashApiToken(body.token))
    assert.notEqual(stored.tokenHash, body.token)
    assert.equal(stored.userId, adminId)

    const listed = (await app.inject({ url: '/admin/api-tokens', headers: sessions['admin']! })).json() as Array<Record<string, unknown>>
    const row = listed.find((t) => t['id'] === body.id)!
    assert.equal(row['createdBy'], 'admin@example.test')
    assert.equal(JSON.stringify(listed).includes(body.token), false)
    assert.equal('tokenHash' in row, false)
    assert.equal('token' in row, false)
  })

  it('sets an expiry in days and validates the input', async () => {
    const { body } = await createToken({ expiresInDays: 30 })
    assert.ok(body.expiresAt! > Date.now() + 29 * 86_400_000)
    assert.equal((await createToken({ expiresInDays: 0 })).response.statusCode, 400)
    assert.equal((await createToken({ expiresInDays: 1.5 })).response.statusCode, 400)
    assert.equal((await createToken({ role: 'viewer' })).response.statusCode, 400)
    assert.equal((await createToken({ name: '   ' })).response.statusCode, 400)
    assert.equal((await createToken({ name: 'x'.repeat(81) })).response.statusCode, 400)
  })

  it('is reserved for administrators signed in with a session', async () => {
    const asOperator = await app.inject({ method: 'POST', url: '/admin/api-tokens', headers: sessions['operator']!, payload: { name: 'x', role: 'operator' } })
    assert.equal(asOperator.statusCode, 403)
    assert.equal((await app.inject({ url: '/admin/api-tokens' })).statusCode, 401)
  })
})

describe('authenticating with a token', () => {
  it('grants the token role on admin routes and nothing above it', async () => {
    const operator = (await createToken({ role: 'operator' })).body.token
    assert.equal((await get('/admin/monitors', operator)).statusCode, 200)
    assert.equal((await get('/admin/audit', operator)).statusCode, 403)

    const branding = (await createToken({ role: 'branding' })).body.token
    assert.equal((await get('/admin/layout', branding)).statusCode, 200)
    assert.equal((await get('/admin/monitors', branding)).statusCode, 403)

    const admin = (await createToken({ role: 'admin' })).body.token
    assert.equal((await get('/admin/audit', admin)).statusCode, 200)
  })

  it('records the last use', async () => {
    const { body } = await createToken()
    assert.equal((await db.select().from(apiTokens).where(eq(apiTokens.id, body.id)))[0]!.lastUsedAt, null)
    await get('/admin/monitors', body.token)
    assert.ok((await db.select().from(apiTokens).where(eq(apiTokens.id, body.id)))[0]!.lastUsedAt! > 0)
  })

  it('never reaches account, credential or token management, even with an admin token', async () => {
    const { token } = (await createToken({ role: 'admin' })).body
    for (const url of ['/admin/users', '/admin/oidc', '/admin/status-page-access', '/admin/backups', '/admin/api-tokens', '/auth/session']) {
      const response = await get(url, token)
      assert.equal(response.statusCode, 403, url)
      assert.equal(response.json().error, 'API tokens cannot call this endpoint', url)
    }
    const mint = await app.inject({ method: 'POST', url: '/admin/api-tokens', headers: withToken(token), payload: { name: 'x', role: 'admin' } })
    assert.equal(mint.statusCode, 403)
    const open = await app.inject({ method: 'PUT', url: '/admin/status-page-access', headers: withToken(token), payload: { private: false, ssoCreateViewers: true, ssoViewerDomains: ['example.test'] } })
    assert.equal(open.statusCode, 403)
  })

  it('rejects unknown, expired and revoked tokens', async () => {
    assert.equal((await get('/admin/monitors', 'bsp_nope')).statusCode, 401)

    const expired = (await createToken({ expiresInDays: 1 })).body
    await db.update(apiTokens).set({ expiresAt: Date.now() - 1 }).where(eq(apiTokens.id, expired.id))
    assert.equal((await get('/admin/monitors', expired.token)).statusCode, 401)

    const revoked = (await createToken()).body
    assert.equal((await get('/admin/monitors', revoked.token)).statusCode, 200)
    assert.equal((await app.inject({ method: 'DELETE', url: `/admin/api-tokens/${revoked.id}`, headers: sessions['admin']! })).statusCode, 204)
    assert.equal((await get('/admin/monitors', revoked.token)).statusCode, 401)
    assert.equal((await app.inject({ method: 'DELETE', url: `/admin/api-tokens/${revoked.id}`, headers: sessions['admin']! })).statusCode, 404)
  })

  it('is gone with its creator, and with the Admin role for good', async () => {
    const now = Date.now()
    const [creator] = await db.insert(users).values({ email: 'temp-admin@example.test', passwordHash: 'unused', role: 'admin', createdAt: now }).returning()
    const sessionId = 'session-temp-admin'
    await db.insert(authSessions).values({ id: sessionId, userId: creator!.id, csrfTokenHash: 'unused', createdAt: now, lastSeenAt: now, expiresAt: now + 60_000 })
    const headers = { authorization: `Bearer ${app.jwt.sign({ userId: creator!.id, email: creator!.email, role: 'admin', sessionId })}` }
    const minted = (await app.inject({ method: 'POST', url: '/admin/api-tokens', headers, payload: { name: 'temp', role: 'operator' } })).json() as { token: string }
    assert.equal((await get('/admin/monitors', minted.token)).statusCode, 200)

    // Demoted by another admin: the token dies, and promoting the user again does not bring it back.
    const demote = await app.inject({ method: 'PATCH', url: `/admin/users/${creator!.id}/role`, headers: sessions['admin']!, payload: { role: 'operator' } })
    assert.equal(demote.statusCode, 200)
    assert.equal((await get('/admin/monitors', minted.token)).statusCode, 401)
    await app.inject({ method: 'PATCH', url: `/admin/users/${creator!.id}/role`, headers: sessions['admin']!, payload: { role: 'admin' } })
    assert.equal((await get('/admin/monitors', minted.token)).statusCode, 401)
    assert.equal((await db.select().from(apiTokens).where(eq(apiTokens.userId, creator!.id))).length, 0)

    // Deleting the creator removes the tokens that are left. The role change ended the old session, so sign in again.
    await db.insert(authSessions).values({ id: 'session-temp-admin-2', userId: creator!.id, csrfTokenHash: 'unused', createdAt: now, lastSeenAt: now, expiresAt: now + 60_000 })
    const renewed = { authorization: `Bearer ${app.jwt.sign({ userId: creator!.id, email: creator!.email, role: 'admin', sessionId: 'session-temp-admin-2' })}` }
    const second = (await app.inject({ method: 'POST', url: '/admin/api-tokens', headers: renewed, payload: { name: 'temp2', role: 'operator' } })).json() as { token: string }
    assert.equal((await get('/admin/monitors', second.token)).statusCode, 200)
    await db.delete(users).where(eq(users.id, creator!.id))
    assert.equal((await get('/admin/monitors', second.token)).statusCode, 401)
    assert.equal((await db.select().from(apiTokens).where(eq(apiTokens.userId, creator!.id))).length, 0)
  })

  it('names the token next to its creator in the audit log', async () => {
    const { body } = await createToken({ name: 'GitHub Actions' })
    const created = await app.inject({ method: 'POST', url: '/admin/monitors', headers: withToken(body.token), payload: { name: 'From CI', type: 'webhook', config: {} } })
    assert.equal(created.statusCode, 200)
    const entry = (await db.select().from(auditLog).where(and(eq(auditLog.entityType, 'monitor'), eq(auditLog.entityName, 'From CI'))))[0]!
    assert.equal(entry.userEmail, 'admin@example.test (token: GitHub Actions)')
    assert.equal(entry.userId, adminId)
  })
})

describe('rate limiting', () => {
  it('allows 300 requests a minute per token, then answers 429', async () => {
    const { body } = await createToken()
    for (let i = 0; i < 300; i++) assert.equal(consumeApiTokenBudget(body.id, 1_000), true)
    assert.equal(consumeApiTokenBudget(body.id, 1_000), false)
    assert.equal(consumeApiTokenBudget(body.id, 1_000 + 60_000), true)
  })

  it('counts a request once even though several hooks authenticate it', async () => {
    const { body } = await createToken()
    // /admin/monitors runs requireAuth and requireRole: counted twice, request 151 would already be refused.
    for (let i = 0; i < 300; i++) assert.equal((await get('/admin/monitors', body.token)).statusCode, 200, `request ${i + 1}`)
    const limited = await get('/admin/monitors', body.token)
    assert.equal(limited.statusCode, 429)
    assert.equal(limited.headers['retry-after'], '60')
    // Another token has its own budget.
    const other = (await createToken()).body
    assert.equal((await get('/admin/monitors', other.token)).statusCode, 200)
  })
})
