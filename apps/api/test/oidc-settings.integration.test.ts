import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import cookie from '@fastify/cookie'
import jwt from '@fastify/jwt'
import bcrypt from 'bcryptjs'
import Fastify from 'fastify'
import { db } from '../src/db/client.js'
import { auditLog, oidcSettings, users } from '../src/db/schema.js'
import { requireAuth, requireRole } from '../src/middleware/auth.js'
import { authRoutes } from '../src/routes/auth.js'
import { oidcSettingsRoutes } from '../src/routes/oidcSettings.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-oidc-settings-test-')
process.env['VAULT_ENCRYPTION_KEY'] = 'abcdef0123456789'.repeat(4)
for (const name of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_FORCE_PASSWORD_LOGIN']) delete process.env[name]

const app = Fastify({ logger: false })
const password = 'correct-password'

type InjectResponse = Awaited<ReturnType<typeof app.inject>>

function sessionHeaders(response: InjectResponse): Record<string, string> {
  const raw = response.headers['set-cookie']
  const cookies = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((value) => value.split(';', 1)[0]!)
  const csrf = cookies.find((value) => value.startsWith('bsp_csrf='))?.slice('bsp_csrf='.length)
  assert.ok(csrf)
  return { cookie: cookies.join('; '), 'x-csrf-token': csrf }
}

const valid = {
  enabled: true,
  issuer: 'https://idp.example.test',
  clientId: 'bsp',
  clientSecret: 'super-secret-value',
  redirectUri: 'https://status.example.test/api/v1/auth/oidc/callback',
  currentPassword: password,
}

let admin: Record<string, string>
let operator: Record<string, string>

before(async () => {
  initTestDb()
  await app.register(jwt, { secret: 'integration-secret-with-sufficient-entropy' })
  await app.register(cookie)
  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(async (protectedApp) => {
    protectedApp.addHook('preHandler', requireAuth)
    protectedApp.register(async (adminApp) => {
      adminApp.addHook('preHandler', requireRole())
      adminApp.register(oidcSettingsRoutes, { prefix: '/oidc' })
    })
  }, { prefix: '/admin' })
  await app.ready()

  const passwordHash = await bcrypt.hash(password, 4)
  await db.insert(users).values([
    { email: 'admin@example.test', passwordHash, role: 'admin', createdAt: Date.now() },
    { email: 'operator@example.test', passwordHash, role: 'operator', createdAt: Date.now() },
  ])
  const login = (email: string) => app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } })
  admin = sessionHeaders(await login('admin@example.test'))
  operator = sessionHeaders(await login('operator@example.test'))
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

describe('OIDC settings', () => {
  it('is admin only', async () => {
    assert.equal((await app.inject({ url: '/admin/oidc', headers: operator })).statusCode, 403)
    assert.equal((await app.inject({ url: '/admin/oidc' })).statusCode, 401)
  })

  it('advertises password-only sign-in until OIDC is saved', async () => {
    const response = await app.inject({ url: '/auth/config' })
    assert.deepEqual(response.json(), { passwordLogin: true, oidc: null })
  })

  it('requires the current password to save', async () => {
    const response = await app.inject({ method: 'PUT', url: '/admin/oidc', headers: admin, payload: { ...valid, currentPassword: 'wrong' } })
    assert.equal(response.statusCode, 400)
  })

  it('rejects an enabled configuration without a valid issuer', async () => {
    const response = await app.inject({ method: 'PUT', url: '/admin/oidc', headers: admin, payload: { ...valid, issuer: 'javascript:alert(1)' } })
    assert.equal(response.statusCode, 400)
  })

  it('saves settings, encrypts the secret and never returns it', async () => {
    const response = await app.inject({ method: 'PUT', url: '/admin/oidc', headers: admin, payload: valid })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().hasClientSecret, true)
    assert.equal(JSON.stringify(response.json()).includes(valid.clientSecret), false)

    const row = (await db.select().from(oidcSettings))[0]!
    assert.notEqual(row.clientSecret, valid.clientSecret)
    assert.ok(row.clientSecret.length > 0)

    const read = await app.inject({ url: '/admin/oidc', headers: admin })
    assert.equal(read.json().source, 'database')
    assert.equal(JSON.stringify(read.json()).includes(valid.clientSecret), false)

    // Takes effect immediately, no restart.
    const config = await app.inject({ url: '/auth/config' })
    assert.deepEqual(config.json(), { passwordLogin: true, oidc: { label: 'Sign in with SSO' } })
  })

  it('keeps the stored secret when none is sent and audits without the secret value', async () => {
    const before = (await db.select().from(oidcSettings))[0]!.clientSecret
    const { clientSecret: _omit, ...withoutSecret } = valid
    const response = await app.inject({ method: 'PUT', url: '/admin/oidc', headers: admin, payload: { ...withoutSecret, buttonLabel: 'Company SSO' } })
    assert.equal(response.statusCode, 200)
    assert.equal((await db.select().from(oidcSettings))[0]!.clientSecret, before)
    assert.equal((await app.inject({ url: '/auth/config' })).json().oidc.label, 'Company SSO')

    const audit = await db.select().from(auditLog)
    assert.ok(audit.some((entry) => entry.entityType === 'oidc_settings'))
    assert.equal(audit.some((entry) => (entry.diff ?? '').includes(valid.clientSecret)), false)
  })

  it('refuses to disable password login when the IdP cannot be reached', async () => {
    const response = await app.inject({
      method: 'PUT', url: '/admin/oidc', headers: admin,
      payload: { ...valid, issuer: 'http://127.0.0.1:9', disablePasswordLogin: true },
    })
    assert.equal(response.statusCode, 400)
    assert.match(response.json().error, /discovery/i)
    assert.equal((await app.inject({ url: '/auth/config' })).json().passwordLogin, true)
  })

  it('turning OIDC off also clears the password-login switch', async () => {
    await db.update(oidcSettings).set({ disablePasswordLogin: 1 })
    const response = await app.inject({ method: 'PUT', url: '/admin/oidc', headers: admin, payload: { ...valid, enabled: false } })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().disablePasswordLogin, false)
    assert.deepEqual((await app.inject({ url: '/auth/config' })).json(), { passwordLogin: true, oidc: null })
  })

  it('environment configuration overrides and locks the UI settings', async () => {
    process.env['OIDC_ISSUER'] = 'https://env-idp.example.test'
    process.env['OIDC_CLIENT_ID'] = 'env-client'
    process.env['PUBLIC_URL'] = 'https://status.example.test'
    try {
      const read = await app.inject({ url: '/admin/oidc', headers: admin })
      assert.equal(read.json().envManaged, true)
      const put = await app.inject({ method: 'PUT', url: '/admin/oidc', headers: admin, payload: valid })
      assert.equal(put.statusCode, 409)
    } finally {
      delete process.env['OIDC_ISSUER']
      delete process.env['OIDC_CLIENT_ID']
      delete process.env['PUBLIC_URL']
    }
  })

  it('rejects password login when disabled while OIDC is active', async () => {
    await db.update(oidcSettings).set({ enabled: 1, disablePasswordLogin: 1, issuer: valid.issuer, clientId: valid.clientId, redirectUri: valid.redirectUri })
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@example.test', password } })
    assert.equal(login.statusCode, 403)

    process.env['OIDC_FORCE_PASSWORD_LOGIN'] = 'true'
    try {
      const forced = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@example.test', password } })
      assert.equal(forced.statusCode, 200)
    } finally {
      delete process.env['OIDC_FORCE_PASSWORD_LOGIN']
    }
  })
})
