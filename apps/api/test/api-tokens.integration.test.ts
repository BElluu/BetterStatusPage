import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify, { type RouteOptions } from 'fastify'
import jwt from '@fastify/jwt'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import { and, eq } from 'drizzle-orm'
import { API_TOKEN_SCOPES } from '@bsp/shared'
import { adminApi } from '../src/adminApi.js'
import { db } from '../src/db/client.js'
import { apiTokens, auditLog, authSessions, monitors, users } from '../src/db/schema.js'
import { requireAuth } from '../src/middleware/auth.js'
import { consumeApiTokenBudget, hashApiToken, resetApiTokenBudgets } from '../src/services/apiTokens.js'
import { VAULT_USE_REFUSED } from '../src/services/vaultUse.js'
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

interface Created { id: number; token: string; prefix: string; scopes: string[]; expiresAt: number | null }
async function createToken(payload: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: 'POST', url: '/admin/api-tokens', headers: sessions['admin']!,
    payload: { name: 'CI', scopes: ['monitors:read'], ...payload },
  })
  return { response, body: response.json() as Created }
}

const withToken = (token: string) => ({ authorization: `Bearer ${token}` })
const get = (url: string, token: string) => app.inject({ url, headers: withToken(token) })
const tokenWith = async (...scopes: string[]) => (await createToken({ scopes })).body.token
const url = (route: RouteOptions) => (route.url.length > 1 ? route.url.replace(/\/$/, '') : route.url)

describe('which admin routes accept a token, and for what', () => {
  const SESSION_ONLY = ['/admin/users', '/admin/oidc', '/admin/status-page-access', '/admin/backups', '/admin/api-tokens']
  /** The part of the API each group of routes belongs to. */
  const PARTS: Record<string, string> = {
    '/admin/monitors': 'monitors', '/admin/incidents': 'incidents', '/admin/notifications': 'channels', '/admin/subscribers': 'subscribers',
    '/admin/reports': 'reports', '/admin/layout': 'appearance', '/admin/branding': 'appearance', '/admin/locales': 'appearance',
    '/admin/maintenance': 'maintenance', '/admin/audit': 'audit', '/admin/system-health': 'system', '/admin/config': 'custom',
  }
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
    const vaults = under('/admin/vaults')
    assert.ok(vaults.some((route) => route.config?.allowApiToken === false), 'vault management is session only')
  })

  it('gives every route a token may reach a part of the API to be checked against, so none is open by omission', () => {
    for (const route of registeredRoutes.filter((candidate) => candidate.url.startsWith('/admin') && candidate.config?.allowApiToken === true)) {
      assert.equal(typeof route.config?.tokenScope, 'string', `${String(route.method)} ${route.url} names no part of the API`)
    }
    for (const [prefix, part] of Object.entries(PARTS)) {
      const routes = under(prefix)
      assert.ok(routes.length > 0, prefix)
      for (const route of routes) assert.equal(route.config?.tokenScope, part, `${String(route.method)} ${url(route)}`)
    }
    const catalogue = under('/admin/vaults').filter((route) => route.config?.allowApiToken === true)
    assert.ok(catalogue.length > 0)
    for (const route of catalogue) assert.equal(route.config?.tokenScope, 'vault')
  })
})

describe('creating and listing tokens', () => {
  it('shows the plaintext once and stores only its hash', async () => {
    const { response, body } = await createToken({ name: '  Deploy pipeline  ', scopes: ['incidents:write'] })
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
    assert.deepEqual(row['scopes'], ['incidents:read', 'incidents:write'])
    assert.equal(JSON.stringify(listed).includes(body.token), false)
    for (const secret of ['tokenHash', 'token', 'role']) assert.equal(secret in row, false, secret)
  })

  it('adds reading wherever writing is granted, and keeps only known permissions in a fixed order', async () => {
    const { body } = await createToken({ scopes: ['vault:use', 'monitors:write', 'audit:read', 'monitors:write'] })
    assert.deepEqual(body.scopes, ['monitors:read', 'monitors:write', 'audit:read', 'vault:use'])
    assert.deepEqual(API_TOKEN_SCOPES.filter((scope) => body.scopes.includes(scope)), body.scopes)
  })

  it('expires after 90 days unless told otherwise, and never only when asked to', async () => {
    const DAY = 86_400_000
    const standard = (await createToken()).body.expiresAt!
    assert.ok(standard > Date.now() + 89 * DAY && standard < Date.now() + 91 * DAY)
    assert.ok((await createToken({ expiresInDays: 30 })).body.expiresAt! < Date.now() + 31 * DAY)
    assert.equal((await createToken({ expiresInDays: null })).body.expiresAt, null)
  })

  it('validates the input', async () => {
    for (const bad of [{ expiresInDays: 0 }, { expiresInDays: 1.5 }, { expiresInDays: 4000 }, { name: '   ' }, { name: 'x'.repeat(81) },
      { scopes: [] }, { scopes: ['monitors:delete'] }, { scopes: 'monitors:read' }, { scopes: undefined }, { scopes: [7] }]) {
      assert.equal((await createToken(bad)).response.statusCode, 400, JSON.stringify(bad))
    }
    // The old way of naming a role is not understood any more.
    const legacy = await app.inject({ method: 'POST', url: '/admin/api-tokens', headers: sessions['admin']!, payload: { name: 'old', role: 'admin' } })
    assert.equal(legacy.statusCode, 400)
  })

  it('is reserved for administrators signed in with a session', async () => {
    const asOperator = await app.inject({ method: 'POST', url: '/admin/api-tokens', headers: sessions['operator']!, payload: { name: 'x', scopes: ['monitors:read'] } })
    assert.equal(asOperator.statusCode, 403)
    assert.equal((await app.inject({ url: '/admin/api-tokens' })).statusCode, 401)
  })
})

describe('what a token may do', () => {
  it('reads what it was given read access to and nothing else', async () => {
    const token = await tokenWith('monitors:read')
    assert.equal((await get('/admin/monitors', token)).statusCode, 200)
    for (const other of ['/admin/incidents', '/admin/maintenance', '/admin/notifications/channels', '/admin/layout', '/admin/audit', '/admin/system-health', '/admin/subscribers', '/admin/reports/uptime']) {
      const response = await get(other, token)
      assert.equal(response.statusCode, 403, other)
      assert.match(response.json().error, /^This token does not have the "[a-z]+:read" permission$/, other)
    }
  })

  it('changes only what it was given write access to, and writing includes reading', async () => {
    const reader = await tokenWith('monitors:read')
    const refused = await app.inject({ method: 'POST', url: '/admin/monitors', headers: withToken(reader), payload: { name: 'No', type: 'webhook' } })
    assert.equal(refused.statusCode, 403)
    assert.equal(refused.json().error, 'This token does not have the "monitors:write" permission')

    const writer = await tokenWith('monitors:write')
    assert.equal((await get('/admin/monitors', writer)).statusCode, 200)
    const created = await app.inject({ method: 'POST', url: '/admin/monitors', headers: withToken(writer), payload: { name: 'Via token', type: 'webhook' } })
    assert.equal(created.statusCode, 200)
    assert.equal((await get('/admin/incidents', writer)).statusCode, 403)
  })

  it('treats each part of the API separately', async () => {
    const token = await tokenWith('appearance:write', 'audit:read', 'system:read', 'reports:read')
    for (const allowed of ['/admin/layout', '/admin/branding', '/admin/audit', '/admin/system-health', '/admin/reports/uptime']) {
      assert.equal((await get(allowed, token)).statusCode, 200, allowed)
    }
    assert.equal((await get('/admin/monitors', token)).statusCode, 403)
  })

  it('needs the vault permission even to list vault and secret names', async () => {
    const without = await tokenWith('monitors:write', 'channels:write')
    assert.equal((await get('/admin/vaults', without)).statusCode, 403)
    assert.equal((await get('/admin/vaults', await tokenWith('vault:use'))).statusCode, 200)
  })

  it('never reaches account, credential or token management, whatever it was given', async () => {
    const token = await tokenWith(...API_TOKEN_SCOPES)
    for (const path of ['/admin/users', '/admin/oidc', '/admin/status-page-access', '/admin/backups', '/admin/api-tokens', '/auth/session']) {
      const response = await get(path, token)
      assert.equal(response.statusCode, 403, path)
      assert.equal(response.json().error, 'API tokens cannot call this endpoint', path)
    }
    const mint = await app.inject({ method: 'POST', url: '/admin/api-tokens', headers: withToken(token), payload: { name: 'x', scopes: ['monitors:read'] } })
    assert.equal(mint.statusCode, 403)
    const open = await app.inject({ method: 'PUT', url: '/admin/status-page-access', headers: withToken(token), payload: { private: false, ssoCreateViewers: true, ssoViewerDomains: ['example.test'] } })
    assert.equal(open.statusCode, 403)
  })

  it('records the last use', async () => {
    const { body } = await createToken()
    assert.equal((await db.select().from(apiTokens).where(eq(apiTokens.id, body.id)))[0]!.lastUsedAt, null)
    await get('/admin/monitors', body.token)
    assert.ok((await db.select().from(apiTokens).where(eq(apiTokens.id, body.id)))[0]!.lastUsedAt! > 0)
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
    const minted = (await app.inject({ method: 'POST', url: '/admin/api-tokens', headers, payload: { name: 'temp', scopes: ['monitors:read'] } })).json() as { token: string }
    assert.equal((await get('/admin/monitors', minted.token)).statusCode, 200)

    // Demoted by another admin: the token dies, and promoting the user again does not bring it back.
    const demote = await app.inject({ method: 'PATCH', url: `/admin/users/${creator!.id}/role`, headers: sessions['admin']!, payload: { role: 'operator' } })
    assert.equal(demote.statusCode, 200)
    assert.equal((await get('/admin/monitors', minted.token)).statusCode, 401)
    await app.inject({ method: 'PATCH', url: `/admin/users/${creator!.id}/role`, headers: sessions['admin']!, payload: { role: 'admin' } })
    assert.equal((await get('/admin/monitors', minted.token)).statusCode, 401)
    assert.equal((await db.select().from(apiTokens).where(eq(apiTokens.userId, creator!.id))).length, 0)
    // The tokens that went with the demotion are in the audit log, one entry each, by name and prefix, never the token.
    const removed = (await db.select().from(auditLog).where(eq(auditLog.entityName, 'temp'))).filter((e) => e.entityType === 'api_token' && e.action === 'delete')
    assert.equal(removed.length, 1)
    assert.match(JSON.parse(removed[0]!.diff!).reason, /no longer an administrator/)
    assert.equal(removed[0]!.diff!.includes(minted.token), false)

    // Deleting the creator removes the tokens that are left. The role change ended the old session, so sign in again.
    await db.insert(authSessions).values({ id: 'session-temp-admin-2', userId: creator!.id, csrfTokenHash: 'unused', createdAt: now, lastSeenAt: now, expiresAt: now + 60_000 })
    const renewed = { authorization: `Bearer ${app.jwt.sign({ userId: creator!.id, email: creator!.email, role: 'admin', sessionId: 'session-temp-admin-2' })}` }
    const second = (await app.inject({ method: 'POST', url: '/admin/api-tokens', headers: renewed, payload: { name: 'temp2', scopes: ['monitors:read'] } })).json() as { token: string }
    assert.equal((await get('/admin/monitors', second.token)).statusCode, 200)
    await db.delete(users).where(eq(users.id, creator!.id))
    assert.equal((await get('/admin/monitors', second.token)).statusCode, 401)
    assert.equal((await db.select().from(apiTokens).where(eq(apiTokens.userId, creator!.id))).length, 0)
  })

  it('names the token next to its creator in the audit log', async () => {
    const token = await tokenWith('monitors:write')
    const created = await app.inject({ method: 'POST', url: '/admin/monitors', headers: withToken(token), payload: { name: 'From CI', type: 'webhook', config: {} } })
    assert.equal(created.statusCode, 200)
    const entry = (await db.select().from(auditLog).where(and(eq(auditLog.entityType, 'monitor'), eq(auditLog.entityName, 'From CI'))))[0]!
    assert.equal(entry.userEmail, 'admin@example.test (token: CI)')
    assert.equal(entry.userId, adminId)
  })
})

describe('using vault secrets', () => {
  const REF = { vaultId: 1, secretId: 2 }
  const postMonitor = (token: string, config: Record<string, unknown>, name = 'Vaulted') =>
    app.inject({ method: 'POST', url: '/admin/monitors', headers: withToken(token), payload: { name, type: 'postgresql', config: { host: 'db.internal', port: 5432, database: 'd', user: '', password: '', query: 'select 1', mode: 'fields', ...config } } })

  it('is refused to a token without the permission when it adds, changes or tests a reference', async () => {
    const token = await tokenWith('monitors:write', 'channels:write')
    const refused = await postMonitor(token, { vault: REF })
    assert.equal(refused.statusCode, 403)
    assert.equal(refused.json().error, VAULT_USE_REFUSED)

    const test = await app.inject({ method: 'POST', url: '/admin/monitors/test', headers: withToken(token), payload: { type: 'postgresql', config: { host: 'attacker.test', port: 5432, database: 'd', user: '', password: '', query: 'select 1', mode: 'fields', vault: REF } } })
    assert.equal(test.statusCode, 403)

    const channel = await app.inject({ method: 'POST', url: '/admin/notifications/channels', headers: withToken(token), payload: { name: 'Bot', type: 'telegram', config: { chatId: '1', vault: REF } } })
    assert.equal(channel.statusCode, 403)
  })

  it('is allowed to a token that has it', async () => {
    const token = await tokenWith('monitors:write', 'vault:use')
    assert.equal((await postMonitor(token, { vault: REF }, 'Allowed')).statusCode, 200)
  })

  it('leaves the rest of a monitor that holds a reference editable, but not its configuration', async () => {
    const monitor = (await postMonitor(await tokenWith('monitors:write', 'vault:use'), { vault: REF }, 'Held')).json()
    const token = await tokenWith('monitors:write')
    const patch = (body: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/admin/monitors/${monitor.id}`, headers: withToken(token), payload: body })

    // Name and schedule are not where the secret goes; the same configuration sent back is unchanged.
    assert.equal((await patch({ name: 'Renamed', intervalSecs: 120 })).statusCode, 200)
    assert.equal((await patch({ config: monitor.config })).statusCode, 200)
    // Any change of the configuration could send the secret somewhere, or read data with it, so none is allowed.
    for (const change of [{ host: 'attacker.test' }, { query: 'select password_hash from users' }, { database: 'other' }, { vault: { vaultId: 1, secretId: 9 } }]) {
      const refused = await patch({ config: { ...monitor.config, ...change } })
      assert.equal(refused.statusCode, 403, JSON.stringify(change))
      assert.equal(refused.json().error, VAULT_USE_REFUSED)
    }
    // Taking the reference away is fine: the secret is no longer used.
    assert.equal((await patch({ config: { ...monitor.config, vault: undefined, user: 'u', password: 'p' } })).statusCode, 200)
    const stored = JSON.parse((await db.select().from(monitors).where(eq(monitors.id, monitor.id)))[0]!.config)
    assert.equal(stored.host, 'db.internal')
    assert.equal(stored.query, 'select 1')
  })

  it('treats a reference of any shape as one, so ids sent as text do not get past it', async () => {
    const token = await tokenWith('monitors:write', 'channels:write')
    for (const vault of [{ vaultId: '1', secretId: '2' }, { vaultId: 1 }, {}, 'x', [REF]]) {
      assert.equal((await postMonitor(token, { vault }, 'Sneaky')).statusCode, 403, JSON.stringify(vault))
    }
    const channel = await app.inject({ method: 'POST', url: '/admin/notifications/channels', headers: withToken(token), payload: { name: 'Hook', type: 'webhook', config: { url: 'https://x.test', method: 'POST', vault: { vaultId: '1', secretId: '2' } } } })
    assert.equal(channel.statusCode, 403)
  })

  it('does not let a test of a saved monitor run a different query with its secret', async () => {
    const monitor = (await postMonitor(await tokenWith('monitors:write', 'vault:use'), { vault: REF }, 'Tested')).json()
    const token = await tokenWith('monitors:write')
    const test = (config: Record<string, unknown>) => app.inject({ method: 'POST', url: '/admin/monitors/test', headers: withToken(token), payload: { type: 'postgresql', monitorId: monitor.id, config } })
    assert.equal((await test({ ...monitor.config, query: 'select password_hash from users' })).statusCode, 403)
  })

  it('also guards the SMTP server a vault secret is sent to', async () => {
    const withReference = { host: 'smtp.example.test', port: 587, secure: 0, user: '', fromAddress: 'a@example.test', fromName: 'Alerts', vault: REF }
    const token = await tokenWith('channels:write')
    const put = (body: Record<string, unknown>, bearer: string) => app.inject({ method: 'PUT', url: '/admin/notifications/smtp', headers: withToken(bearer), payload: body })
    assert.equal((await put(withReference, token)).statusCode, 403)
    assert.equal((await put(withReference, await tokenWith('channels:write', 'vault:use'))).statusCode, 200)
    // Now saved: the same settings go through, another server does not.
    assert.equal((await put({ ...withReference, fromName: 'Renamed' }, token)).statusCode, 200)
    assert.equal((await put({ ...withReference, host: 'attacker.test' }, token)).statusCode, 403)
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
