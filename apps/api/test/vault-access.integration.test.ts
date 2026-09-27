import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import jwt from '@fastify/jwt'
import { eq } from 'drizzle-orm'
import { requireAuth, requireRole } from '../src/middleware/auth.js'
import { authSessions, monitors, smtpSettings, users, vaultSecrets, vaults } from '../src/db/schema.js'
import { db } from '../src/db/client.js'
import { encrypt } from '../src/crypto/vault.js'
import { monitorRoutes } from '../src/routes/monitors.js'
import { notificationRoutes } from '../src/routes/notifications.js'
import { vaultCatalogRoutes, vaultRoutes } from '../src/routes/vaults.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-vault-access-')
process.env['VAULT_ENCRYPTION_KEY'] = 'abcdef0123456789'.repeat(4)

const app = Fastify({ logger: false })
const headers: Record<string, { authorization: string }> = {}
let vaultId = 0
let secretId = 0
let otherSecretId = 0


function httpsConfig(url: string, vault?: Record<string, unknown>) {
  return { url, method: 'GET', expectedStatus: 200, auth: { type: 'basic', basic: { username: '', password: '', ...(vault ? { vault } : {}) } } }
}

before(async () => {
  initTestDb()
  const now = Date.now()
  const [vault] = await db.insert(vaults).values({ name: 'Production', createdAt: now, updatedAt: now }).returning()
  vaultId = vault!.id
  const [secret, other] = await db.insert(vaultSecrets).values([
    { vaultId, name: 'Service login', type: 'userpass', encryptedValue: encrypt(JSON.stringify({ username: 'svc', password: 'pw' })), createdAt: now, updatedAt: now },
    { vaultId, name: 'Root login', type: 'userpass', encryptedValue: encrypt(JSON.stringify({ username: 'root', password: 'root-pw' })), createdAt: now, updatedAt: now },
  ]).returning()
  secretId = secret!.id
  otherSecretId = other!.id

  await app.register(jwt, { secret: 'test-secret-with-sufficient-entropy' })
  await app.register(cookie)
  await app.register(async (adminApp) => {
    adminApp.addHook('preHandler', requireAuth)
    await adminApp.register(async (sub) => {
      sub.addHook('preHandler', requireRole('operator'))
      await sub.register(monitorRoutes, { prefix: '/monitors' })
      await sub.register(notificationRoutes, { prefix: '/notifications' })
      await sub.register(vaultCatalogRoutes, { prefix: '/vaults' })
    })
    await adminApp.register(async (sub) => {
      sub.addHook('preHandler', requireRole())
      await sub.register(vaultRoutes, { prefix: '/vaults' })
    })
  }, { prefix: '/admin' })
  await app.ready()

  for (const role of ['admin', 'operator']) {
    const [user] = await db.insert(users).values({ email: `${role}@example.test`, passwordHash: 'unused', role, createdAt: now }).returning()
    const sessionId = `session-${role}`
    await db.insert(authSessions).values({ id: sessionId, userId: user!.id, csrfTokenHash: 'unused', createdAt: now, lastSeenAt: now, expiresAt: now + 60 * 60_000 })
    headers[role] = { authorization: `Bearer ${app.jwt.sign({ userId: user!.id, email: user!.email, role, sessionId })}` }
  }
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

describe('vault catalogue for operators', () => {
  it('lists vaults and secret names and types, never values', async () => {
    const listed = await app.inject({ url: '/admin/vaults', headers: headers['operator'] })
    assert.equal(listed.statusCode, 200)
    assert.deepEqual(listed.json().map((vault: { name: string }) => vault.name), ['Production'])

    const secrets = await app.inject({ url: `/admin/vaults/${vaultId}/secrets`, headers: headers['operator'] })
    assert.equal(secrets.statusCode, 200)
    assert.deepEqual(secrets.json().map((secret: { name: string; type: string }) => [secret.name, secret.type]).sort(), [['Root login', 'userpass'], ['Service login', 'userpass']])
    assert.ok(!secrets.body.includes('root-pw'))
    assert.ok(secrets.json().every((secret: Record<string, unknown>) => !('encryptedValue' in secret) && !('value' in secret)))
  })

  it('keeps creating, editing, deleting and revealing secrets admin-only', async () => {
    const operatorHeaders = headers['operator']
    const attempts = [
      { method: 'POST' as const, url: '/admin/vaults', payload: { name: 'Mine' } },
      { method: 'PATCH' as const, url: `/admin/vaults/${vaultId}`, payload: { name: 'Renamed' } },
      { method: 'DELETE' as const, url: `/admin/vaults/${vaultId}` },
      { method: 'POST' as const, url: `/admin/vaults/${vaultId}/secrets`, payload: { name: 'New', type: 'value', value: 'x' } },
      { method: 'PATCH' as const, url: `/admin/vaults/${vaultId}/secrets/${secretId}`, payload: { name: 'Changed' } },
      { method: 'DELETE' as const, url: `/admin/vaults/${vaultId}/secrets/${secretId}` },
      { method: 'GET' as const, url: `/admin/vaults/${vaultId}/secrets/${otherSecretId}/reveal` },
    ]
    for (const attempt of attempts) {
      const response = await app.inject({ ...attempt, headers: operatorHeaders })
      assert.equal(response.statusCode, 403, `${attempt.method} ${attempt.url}`)
      assert.ok(!response.body.includes('root-pw'))
    }
    assert.equal((await db.select().from(vaultSecrets)).length, 2)

    const revealed = await app.inject({ url: `/admin/vaults/${vaultId}/secrets/${otherSecretId}/reveal`, headers: headers['admin'] })
    assert.equal(revealed.statusCode, 200)
  })
})

describe('operators pick vault secrets in monitors and SMTP', () => {
  it('lets an operator create, edit and test a monitor that references a vault secret', async () => {
    const created = await app.inject({
      method: 'POST', url: '/admin/monitors', headers: headers['operator'],
      payload: { name: 'API', type: 'https', config: httpsConfig('http://127.0.0.1:1/', { vaultId, secretId }) },
    })
    assert.equal(created.statusCode, 200)
    const id = created.json().id as number

    const swapped = await app.inject({
      method: 'PATCH', url: `/admin/monitors/${id}`, headers: headers['operator'],
      payload: { config: httpsConfig('http://127.0.0.1:1/', { vaultId, secretId: otherSecretId }) },
    })
    assert.equal(swapped.statusCode, 200)
    assert.equal(JSON.parse((await db.select().from(monitors).where(eq(monitors.id, id)))[0]!.config).auth.basic.vault.secretId, otherSecretId)

    const tested = await app.inject({
      method: 'POST', url: '/admin/monitors/test', headers: headers['operator'],
      payload: { type: 'https', config: httpsConfig('http://127.0.0.1:1/', { vaultId, secretId }), timeoutMs: 500 },
    })
    assert.equal(tested.statusCode, 200)
    assert.ok(!tested.body.includes('pw"'))
  })

  it('lets an operator attach a vault secret to SMTP', async () => {
    const smtp = { host: 'smtp.example.test', port: 587, secure: 0, user: '', fromAddress: 'alerts@example.test', fromName: 'BSP Alerts' }
    const response = await app.inject({ method: 'PUT', url: '/admin/notifications/smtp', headers: headers['operator'], payload: { ...smtp, vault: { vaultId, secretId } } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(JSON.parse((await db.select().from(smtpSettings))[0]!.vaultConfig!), { vaultId, secretId })
    await db.delete(smtpSettings)
  })
})

describe('SMTP password', () => {
  const smtp = { host: 'smtp.example.test', port: 587, secure: 0, user: 'mailer', fromAddress: 'alerts@example.test', fromName: 'BSP Alerts' }
  const put = (role: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: '/admin/notifications/smtp', headers: headers[role], payload })

  it('requires the password again when the host, port or username changes', async () => {
    assert.equal((await put('admin', { ...smtp, password: 'smtp-secret' })).statusCode, 200)

    // Unchanged destination: the masked password keeps the stored one.
    assert.equal((await put('admin', { ...smtp, fromName: 'Alerts', password: '••••••••' })).statusCode, 200)
    assert.equal((await db.select().from(smtpSettings))[0]!.password, 'smtp-secret')

    for (const change of [{ host: 'evil.test' }, { port: 2525 }, { user: 'other' }]) {
      const response = await put('admin', { ...smtp, ...change, password: '' })
      assert.equal(response.statusCode, 400, JSON.stringify(change))
      assert.match(response.json().error, /Re-enter the SMTP password/)
    }
    const row = (await db.select().from(smtpSettings))[0]!
    assert.equal(row.host, 'smtp.example.test')
    assert.equal(row.password, 'smtp-secret')

    assert.equal((await put('admin', { ...smtp, host: 'new.example.test', password: 'new-secret' })).statusCode, 200)
    assert.equal((await db.select().from(smtpSettings))[0]!.password, 'new-secret')
  })
})
