import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import cookie from '@fastify/cookie'
import bcrypt from 'bcryptjs'
import { db, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { users } from '../src/db/schema.js'
import { requireAuth, requireRole } from '../src/middleware/auth.js'
import { authRoutes } from '../src/routes/auth.js'
import { userRoutes } from '../src/routes/users.js'
import { vaultRoutes } from '../src/routes/vaults.js'
import { resolveVaultSecret } from '../src/workers/resolveSecret.js'
import { generateTotpCode } from '../src/crypto/totp.js'
import { systemHealthRoutes } from '../src/routes/systemHealth.js'

const dataDir = mkdtempSync(join(tmpdir(), 'bsp-security-test-'))
process.env['DATABASE_PATH'] = join(dataDir, 'test.sqlite')
process.env['VAULT_ENCRYPTION_KEY'] = 'abcdef0123456789'.repeat(4)

const app = Fastify({ logger: false })
const adminPassword = 'admin-password'
let adminId = 0
let adminHeaders: Record<string, string> = {}
let operatorHeaders: Record<string, string> = {}

function sessionHeaders(response: { headers: Record<string, string | string[] | undefined> }) {
  const raw = response.headers['set-cookie']
  const setCookies = Array.isArray(raw) ? raw : raw ? [raw] : []
  const values = setCookies.map((value) => value.split(';', 1)[0]!)
  const csrf = values.find((value) => value.startsWith('bsp_csrf='))?.slice('bsp_csrf='.length)
  assert.ok(csrf)
  return { cookie: values.join('; '), 'x-csrf-token': csrf }
}

before(async () => {
  initDb()
  runMigrations()
  const passwordHash = await bcrypt.hash(adminPassword, 4)
  const [admin, operator] = await db.insert(users).values([
    { email: 'admin@example.test', passwordHash, role: 'admin', createdAt: Date.now() },
    { email: 'operator@example.test', passwordHash, role: 'operator', createdAt: Date.now() },
  ]).returning()
  adminId = admin!.id

  await app.register(jwt, { secret: 'integration-secret-with-sufficient-entropy' })
  await app.register(cookie)
  await app.register(rateLimit, { global: false })
  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(async (protectedApp) => {
    protectedApp.addHook('preHandler', requireAuth)
    protectedApp.register(async (adminApp) => {
      adminApp.addHook('preHandler', requireRole())
      adminApp.register(userRoutes, { prefix: '/users' })
      adminApp.register(vaultRoutes, { prefix: '/vaults' })
      adminApp.register(systemHealthRoutes, { prefix: '/system-health' })
    })
  }, { prefix: '/admin' })
  await app.ready()

  adminHeaders = sessionHeaders(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: admin!.email, password: adminPassword } }))
  operatorHeaders = sessionHeaders(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: operator!.email, password: adminPassword } }))
})

after(async () => {
  await app.close()
  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('authentication', () => {
  it('rejects unknown users and incorrect passwords without revealing which failed', async () => {
    const unknown = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'missing@example.test', password: 'wrong-password' } })
    const incorrect = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@example.test', password: 'wrong-password' } })
    assert.equal(unknown.statusCode, 401)
    assert.equal(incorrect.statusCode, 401)
    assert.deepEqual(unknown.json(), incorrect.json())
  })

  it('creates a secure cookie session and returns the normalized role', async () => {
    const response = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'admin@example.test', password: adminPassword },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().role, 'admin')
    assert.equal(response.json().mustChangePassword, false)
    assert.equal('token' in response.json(), false)
    assert.match(String(response.headers['set-cookie']), /HttpOnly/)
    assert.equal((await app.inject({ url: '/admin/users', headers: sessionHeaders(response) })).statusCode, 200)
  })

  it('requires and verifies the current password for voluntary changes', async () => {
    const missing = await app.inject({ method: 'POST', url: '/auth/change-password', headers: adminHeaders, payload: { newPassword: 'new-admin-password' } })
    assert.equal(missing.statusCode, 400)

    const wrong = await app.inject({ method: 'POST', url: '/auth/change-password', headers: adminHeaders, payload: { newPassword: 'new-admin-password', currentPassword: 'wrong-password' } })
    assert.equal(wrong.statusCode, 400)

    const changed = await app.inject({ method: 'POST', url: '/auth/change-password', headers: adminHeaders, payload: { newPassword: 'new-admin-password', currentPassword: adminPassword } })
    assert.equal(changed.statusCode, 200)
    adminHeaders = sessionHeaders(changed)
    assert.equal((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@example.test', password: adminPassword } })).statusCode, 401)
    assert.equal((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@example.test', password: 'new-admin-password' } })).statusCode, 200)
  })

  it('enforces CSRF and supports TOTP login with recovery codes', async () => {
    const cookieOnly = { cookie: adminHeaders.cookie! }
    assert.equal((await app.inject({ method: 'POST', url: '/auth/logout', headers: cookieOnly })).statusCode, 403)

    const setup = await app.inject({
      method: 'POST', url: '/auth/2fa/setup', headers: adminHeaders,
      payload: { currentPassword: 'new-admin-password' },
    })
    assert.equal(setup.statusCode, 200)
    const setupBody = setup.json()
    assert.match(setupBody.qrDataUrl, /^data:image\/png;base64,/)
    const enabled = await app.inject({
      method: 'POST', url: '/auth/2fa/enable', headers: adminHeaders,
      payload: { setupToken: setupBody.setupToken, code: generateTotpCode(setupBody.secret) },
    })
    assert.equal(enabled.statusCode, 200)
    assert.equal(enabled.json().recoveryCodes.length, 8)

    assert.equal((await app.inject({ method: 'POST', url: '/auth/logout', headers: adminHeaders })).statusCode, 204)
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@example.test', password: 'new-admin-password' } })
    assert.equal(login.json().requiresTwoFactor, true)
    const verified = await app.inject({
      method: 'POST', url: '/auth/2fa/verify',
      payload: { challengeToken: login.json().challengeToken, code: enabled.json().recoveryCodes[0] },
    })
    assert.equal(verified.statusCode, 200)
    adminHeaders = sessionHeaders(verified)
  })
})

describe('user administration', () => {
  it('enforces admin access and protects the current account', async () => {
    assert.equal((await app.inject({ url: '/admin/users', headers: operatorHeaders })).statusCode, 403)
    assert.equal((await app.inject({ method: 'PATCH', url: `/admin/users/${adminId}/role`, headers: adminHeaders, payload: { role: 'operator' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'DELETE', url: `/admin/users/${adminId}`, headers: adminHeaders })).statusCode, 400)
  })

  it('creates, promotes, resets, and deletes a user', async () => {
    const created = await app.inject({ method: 'POST', url: '/admin/users', headers: adminHeaders, payload: { email: 'new@example.test' } })
    assert.equal(created.statusCode, 200)
    const user = created.json()
    assert.equal(user.role, 'branding')
    assert.equal(typeof user.temporaryPassword, 'string')

    const firstLogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: user.email, password: user.temporaryPassword } })
    assert.equal(firstLogin.json().mustChangePassword, true)
    const forcedChange = await app.inject({ method: 'POST', url: '/auth/change-password', headers: sessionHeaders(firstLogin), payload: { newPassword: 'permanent-password' } })
    assert.equal(forcedChange.statusCode, 200)

    const promoted = await app.inject({ method: 'PATCH', url: `/admin/users/${user.id}/role`, headers: adminHeaders, payload: { role: 'operator' } })
    assert.equal(promoted.json().role, 'operator')
    assert.equal((await app.inject({ method: 'PATCH', url: `/admin/users/${user.id}/role`, headers: adminHeaders, payload: { role: 'invalid' } })).statusCode, 400)

    const reset = await app.inject({ method: 'POST', url: `/admin/users/${user.id}/reset-password`, headers: adminHeaders })
    assert.equal(typeof reset.json().temporaryPassword, 'string')
    assert.equal((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: user.email, password: 'permanent-password' } })).statusCode, 401)

    assert.equal((await app.inject({ method: 'DELETE', url: `/admin/users/${user.id}`, headers: adminHeaders })).statusCode, 200)
  })
})

describe('system health administration', () => {
  it('is restricted to administrators and does not expose raw internal errors', async () => {
    assert.equal((await app.inject({ url: '/admin/system-health', headers: operatorHeaders })).statusCode, 403)

    const response = await app.inject({ url: '/admin/system-health', headers: adminHeaders })
    assert.equal(response.statusCode, 200)
    const report = response.json()
    assert.match(report.status, /^(healthy|degraded)$/)
    assert.equal(typeof report.application.version, 'string')
    assert.ok(report.application.version.length > 0)
    assert.equal(typeof report.application.uptimeSeconds, 'number')
    assert.equal(typeof report.database.responseMs, 'number')
    assert.equal('lastError' in report.backups, false)
    assert.equal('lastFilename' in report.backups, false)
  })
})

describe('vault administration', () => {
  it('stores, reveals, resolves, updates, and removes every secret type', async () => {
    const vaultResponse = await app.inject({ method: 'POST', url: '/admin/vaults', headers: adminHeaders, payload: { name: 'Production', description: 'Runtime secrets' } })
    assert.equal(vaultResponse.statusCode, 200)
    const vault = vaultResponse.json()

    const payloads = [
      { name: 'Credentials', type: 'userpass', userpass: { username: 'service', password: 'secret' } },
      { name: 'Token', type: 'value', value: 'api-token' },
      { name: 'JSON', type: 'json', json: '{"client":"abc","secret":"xyz"}' },
    ]
    const secrets = []
    for (const payload of payloads) {
      const response = await app.inject({ method: 'POST', url: `/admin/vaults/${vault.id}/secrets`, headers: adminHeaders, payload })
      assert.equal(response.statusCode, 200)
      assert.equal('encryptedValue' in response.json(), false)
      secrets.push(response.json())
    }

    const listed = await app.inject({ url: `/admin/vaults/${vault.id}/secrets`, headers: adminHeaders })
    assert.equal(listed.json().length, 3)
    assert.equal(listed.json().some((secret: object) => 'encryptedValue' in secret), false)

    const revealed = await app.inject({ url: `/admin/vaults/${vault.id}/secrets/${secrets[0].id}/reveal`, headers: adminHeaders })
    assert.deepEqual(revealed.json().value, { username: 'service', password: 'secret' })
    assert.deepEqual(await resolveVaultSecret({ vaultId: vault.id, secretId: secrets[2].id, fieldMapping: { clientId: 'client', clientSecret: 'secret' } }), { clientId: 'abc', clientSecret: 'xyz' })

    const updated = await app.inject({ method: 'PATCH', url: `/admin/vaults/${vault.id}/secrets/${secrets[1].id}`, headers: adminHeaders, payload: { name: 'Updated token', value: 'new-token' } })
    assert.equal(updated.json().name, 'Updated token')
    assert.deepEqual(await resolveVaultSecret({ vaultId: vault.id, secretId: secrets[1].id }), { value: 'new-token' })

    for (const secret of secrets) {
      assert.equal((await app.inject({ method: 'DELETE', url: `/admin/vaults/${vault.id}/secrets/${secret.id}`, headers: adminHeaders })).statusCode, 204)
    }
    assert.equal((await app.inject({ method: 'DELETE', url: `/admin/vaults/${vault.id}`, headers: adminHeaders })).statusCode, 204)
  })

  it('rejects invalid secret payloads', async () => {
    const vault = (await app.inject({ method: 'POST', url: '/admin/vaults', headers: adminHeaders, payload: { name: 'Validation' } })).json()
    assert.equal((await app.inject({ method: 'POST', url: `/admin/vaults/${vault.id}/secrets`, headers: adminHeaders, payload: { name: 'Bad', type: 'json', json: '{invalid' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: `/admin/vaults/${vault.id}/secrets`, headers: adminHeaders, payload: { name: 'Bad', type: 'unknown' } })).statusCode, 400)
  })
})
