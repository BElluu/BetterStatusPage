import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import bcrypt from 'bcryptjs'
import { db, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { users } from '../src/db/schema.js'
import { requireAuth, requireRole } from '../src/middleware/auth.js'
import { authRoutes } from '../src/routes/auth.js'
import { userRoutes } from '../src/routes/users.js'
import { vaultRoutes } from '../src/routes/vaults.js'
import { resolveVaultSecret } from '../src/workers/resolveSecret.js'

const dataDir = mkdtempSync(join(tmpdir(), 'bsp-security-test-'))
process.env['DATABASE_PATH'] = join(dataDir, 'test.sqlite')
process.env['VAULT_ENCRYPTION_KEY'] = 'abcdef0123456789'.repeat(4)

const app = Fastify({ logger: false })
const adminPassword = 'admin-password'
let adminId = 0
let adminToken = ''
let operatorToken = ''

function bearer(token: string) {
  return { authorization: `Bearer ${token}` }
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
  await app.register(rateLimit, { global: false })
  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(async (protectedApp) => {
    protectedApp.addHook('preHandler', requireAuth)
    protectedApp.register(async (adminApp) => {
      adminApp.addHook('preHandler', requireRole())
      adminApp.register(userRoutes, { prefix: '/users' })
      adminApp.register(vaultRoutes, { prefix: '/vaults' })
    })
  }, { prefix: '/admin' })
  await app.ready()

  adminToken = app.jwt.sign({ userId: admin!.id, email: admin!.email, role: 'admin' })
  operatorToken = app.jwt.sign({ userId: operator!.id, email: operator!.email, role: 'operator' })
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

  it('returns a usable JWT and normalized role for valid credentials', async () => {
    const response = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'admin@example.test', password: adminPassword },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().role, 'admin')
    assert.equal(response.json().mustChangePassword, false)
    assert.equal((await app.inject({ url: '/admin/users', headers: bearer(response.json().token) })).statusCode, 200)
  })

  it('requires and verifies the current password for voluntary changes', async () => {
    const missing = await app.inject({ method: 'POST', url: '/auth/change-password', headers: bearer(adminToken), payload: { newPassword: 'new-admin-password' } })
    assert.equal(missing.statusCode, 400)

    const wrong = await app.inject({ method: 'POST', url: '/auth/change-password', headers: bearer(adminToken), payload: { newPassword: 'new-admin-password', currentPassword: 'wrong-password' } })
    assert.equal(wrong.statusCode, 400)

    const changed = await app.inject({ method: 'POST', url: '/auth/change-password', headers: bearer(adminToken), payload: { newPassword: 'new-admin-password', currentPassword: adminPassword } })
    assert.equal(changed.statusCode, 200)
    assert.equal((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@example.test', password: adminPassword } })).statusCode, 401)
    assert.equal((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@example.test', password: 'new-admin-password' } })).statusCode, 200)
  })
})

describe('user administration', () => {
  it('enforces admin access and protects the current account', async () => {
    assert.equal((await app.inject({ url: '/admin/users', headers: bearer(operatorToken) })).statusCode, 403)
    assert.equal((await app.inject({ method: 'PATCH', url: `/admin/users/${adminId}/role`, headers: bearer(adminToken), payload: { role: 'operator' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'DELETE', url: `/admin/users/${adminId}`, headers: bearer(adminToken) })).statusCode, 400)
  })

  it('creates, promotes, resets, and deletes a user', async () => {
    const created = await app.inject({ method: 'POST', url: '/admin/users', headers: bearer(adminToken), payload: { email: 'new@example.test' } })
    assert.equal(created.statusCode, 200)
    const user = created.json()
    assert.equal(user.role, 'branding')
    assert.equal(typeof user.temporaryPassword, 'string')

    const firstLogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: user.email, password: user.temporaryPassword } })
    assert.equal(firstLogin.json().mustChangePassword, true)
    const forcedChange = await app.inject({ method: 'POST', url: '/auth/change-password', headers: bearer(firstLogin.json().token), payload: { newPassword: 'permanent-password' } })
    assert.equal(forcedChange.statusCode, 200)

    const promoted = await app.inject({ method: 'PATCH', url: `/admin/users/${user.id}/role`, headers: bearer(adminToken), payload: { role: 'operator' } })
    assert.equal(promoted.json().role, 'operator')
    assert.equal((await app.inject({ method: 'PATCH', url: `/admin/users/${user.id}/role`, headers: bearer(adminToken), payload: { role: 'invalid' } })).statusCode, 400)

    const reset = await app.inject({ method: 'POST', url: `/admin/users/${user.id}/reset-password`, headers: bearer(adminToken) })
    assert.equal(typeof reset.json().temporaryPassword, 'string')
    assert.equal((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: user.email, password: 'permanent-password' } })).statusCode, 401)

    assert.equal((await app.inject({ method: 'DELETE', url: `/admin/users/${user.id}`, headers: bearer(adminToken) })).statusCode, 200)
  })
})

describe('vault administration', () => {
  it('stores, reveals, resolves, updates, and removes every secret type', async () => {
    const vaultResponse = await app.inject({ method: 'POST', url: '/admin/vaults', headers: bearer(adminToken), payload: { name: 'Production', description: 'Runtime secrets' } })
    assert.equal(vaultResponse.statusCode, 200)
    const vault = vaultResponse.json()

    const payloads = [
      { name: 'Credentials', type: 'userpass', userpass: { username: 'service', password: 'secret' } },
      { name: 'Token', type: 'value', value: 'api-token' },
      { name: 'JSON', type: 'json', json: '{"client":"abc","secret":"xyz"}' },
    ]
    const secrets = []
    for (const payload of payloads) {
      const response = await app.inject({ method: 'POST', url: `/admin/vaults/${vault.id}/secrets`, headers: bearer(adminToken), payload })
      assert.equal(response.statusCode, 200)
      assert.equal('encryptedValue' in response.json(), false)
      secrets.push(response.json())
    }

    const listed = await app.inject({ url: `/admin/vaults/${vault.id}/secrets`, headers: bearer(adminToken) })
    assert.equal(listed.json().length, 3)
    assert.equal(listed.json().some((secret: object) => 'encryptedValue' in secret), false)

    const revealed = await app.inject({ url: `/admin/vaults/${vault.id}/secrets/${secrets[0].id}/reveal`, headers: bearer(adminToken) })
    assert.deepEqual(revealed.json().value, { username: 'service', password: 'secret' })
    assert.deepEqual(await resolveVaultSecret({ vaultId: vault.id, secretId: secrets[2].id, fieldMapping: { clientId: 'client', clientSecret: 'secret' } }), { clientId: 'abc', clientSecret: 'xyz' })

    const updated = await app.inject({ method: 'PATCH', url: `/admin/vaults/${vault.id}/secrets/${secrets[1].id}`, headers: bearer(adminToken), payload: { name: 'Updated token', value: 'new-token' } })
    assert.equal(updated.json().name, 'Updated token')
    assert.deepEqual(await resolveVaultSecret({ vaultId: vault.id, secretId: secrets[1].id }), { value: 'new-token' })

    for (const secret of secrets) {
      assert.equal((await app.inject({ method: 'DELETE', url: `/admin/vaults/${vault.id}/secrets/${secret.id}`, headers: bearer(adminToken) })).statusCode, 204)
    }
    assert.equal((await app.inject({ method: 'DELETE', url: `/admin/vaults/${vault.id}`, headers: bearer(adminToken) })).statusCode, 204)
  })

  it('rejects invalid secret payloads', async () => {
    const vault = (await app.inject({ method: 'POST', url: '/admin/vaults', headers: bearer(adminToken), payload: { name: 'Validation' } })).json()
    assert.equal((await app.inject({ method: 'POST', url: `/admin/vaults/${vault.id}/secrets`, headers: bearer(adminToken), payload: { name: 'Bad', type: 'json', json: '{invalid' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: `/admin/vaults/${vault.id}/secrets`, headers: bearer(adminToken), payload: { name: 'Bad', type: 'unknown' } })).statusCode, 400)
  })
})
