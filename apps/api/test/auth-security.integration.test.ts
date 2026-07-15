import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import cookie from '@fastify/cookie'
import jwt from '@fastify/jwt'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { encrypt } from '../src/crypto/vault.js'
import { generateRecoveryCodes, generateTotpCode, generateTotpSecret, hashRecoveryCode } from '../src/crypto/totp.js'
import { db, initDb, sqlite } from '../src/db/client.js'
import { authSessions, users } from '../src/db/schema.js'
import { runMigrations } from '../src/db/migrate.js'
import { requireAuth, requireRole } from '../src/middleware/auth.js'
import { authRoutes } from '../src/routes/auth.js'
import { userRoutes } from '../src/routes/users.js'

const dataDir = mkdtempSync(join(tmpdir(), 'bsp-auth-security-test-'))
process.env['DATABASE_PATH'] = join(dataDir, 'test.sqlite')
process.env['VAULT_ENCRYPTION_KEY'] = 'abcdef0123456789'.repeat(4)

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

async function createUser(email: string, role = 'branding') {
  const passwordHash = await bcrypt.hash(password, 4)
  return (await db.insert(users).values({ email, passwordHash, role, createdAt: Date.now() }).returning())[0]!
}

async function login(email: string, loginPassword = password) {
  return app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: loginPassword } })
}

before(async () => {
  initDb()
  runMigrations()
  await app.register(jwt, { secret: 'integration-secret-with-sufficient-entropy' })
  await app.register(cookie)
  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(async (protectedApp) => {
    protectedApp.addHook('preHandler', requireAuth)
    protectedApp.register(async (adminApp) => {
      adminApp.addHook('preHandler', requireRole())
      adminApp.register(userRoutes, { prefix: '/users' })
    })
  }, { prefix: '/admin' })
  await app.ready()
})

after(async () => {
  await app.close()
  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('authentication security regressions', () => {
  it('normalizes legacy roles in actual sessions and applies the cookie policy', async () => {
    await createUser('legacy-admin@example.test', '["admin","operator"]')
    const previousNodeEnv = process.env['NODE_ENV']
    process.env['NODE_ENV'] = 'production'
    const response = await login('legacy-admin@example.test')
    if (previousNodeEnv === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = previousNodeEnv

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().role, 'admin')
    const raw = response.headers['set-cookie']
    const setCookies = Array.isArray(raw) ? raw : raw ? [raw] : []
    const sessionCookie = setCookies.find((value) => value.startsWith('bsp_session='))!
    const csrfCookie = setCookies.find((value) => value.startsWith('bsp_csrf='))!
    assert.match(sessionCookie, /HttpOnly/i)
    assert.doesNotMatch(csrfCookie, /HttpOnly/i)
    for (const value of setCookies) {
      assert.match(value, /Secure/i)
      assert.match(value, /SameSite=Strict/i)
      assert.match(value, /Path=\//i)
      assert.match(value, /Max-Age=43200/i)
    }
    const session = await app.inject({ url: '/auth/session', headers: sessionHeaders(response) })
    assert.equal(session.statusCode, 200)
    assert.equal(session.json().role, 'admin')
  })

  it('revokes the correct sessions after password changes, logout, and logout-all', async () => {
    const user = await createUser('sessions@example.test')
    const first = sessionHeaders(await login(user.email))
    const second = sessionHeaders(await login(user.email))
    const changed = await app.inject({
      method: 'POST', url: '/auth/change-password', headers: first,
      payload: { currentPassword: password, newPassword: 'changed-password' },
    })
    assert.equal(changed.statusCode, 200)
    const current = sessionHeaders(changed)
    assert.equal((await app.inject({ url: '/auth/session', headers: first })).statusCode, 401)
    assert.equal((await app.inject({ url: '/auth/session', headers: second })).statusCode, 401)
    assert.equal((await app.inject({ url: '/auth/session', headers: current })).statusCode, 200)
    assert.equal((await db.select().from(authSessions).where(eq(authSessions.userId, user.id))).length, 1)

    const other = sessionHeaders(await login(user.email, 'changed-password'))
    assert.equal((await app.inject({ method: 'POST', url: '/auth/logout', headers: current })).statusCode, 204)
    assert.equal((await app.inject({ url: '/auth/session', headers: current })).statusCode, 401)
    assert.equal((await app.inject({ url: '/auth/session', headers: other })).statusCode, 200)

    const third = sessionHeaders(await login(user.email, 'changed-password'))
    assert.equal((await app.inject({ method: 'POST', url: '/auth/logout-all', headers: other })).statusCode, 204)
    assert.equal((await app.inject({ url: '/auth/session', headers: other })).statusCode, 401)
    assert.equal((await app.inject({ url: '/auth/session', headers: third })).statusCode, 401)
  })

  it('covers the complete TOTP lifecycle and consumes a recovery code atomically', async () => {
    const user = await createUser('two-factor@example.test')
    const primary = sessionHeaders(await login(user.email))
    const otherSession = sessionHeaders(await login(user.email))
    const setup = await app.inject({
      method: 'POST', url: '/auth/2fa/setup', headers: primary,
      payload: { currentPassword: password },
    })
    assert.equal(setup.statusCode, 200)
    const setupBody = setup.json()
    assert.match(setupBody.uri, /^otpauth:\/\/totp\//)
    assert.match(setupBody.qrDataUrl, /^data:image\/png;base64,/)

    const wrongSetup = app.jwt.sign({ purpose: 'wrong-purpose', userId: user.id, encryptedSecret: encrypt(setupBody.secret) })
    assert.equal((await app.inject({ method: 'POST', url: '/auth/2fa/enable', headers: primary, payload: { setupToken: wrongSetup, code: generateTotpCode(setupBody.secret) } })).statusCode, 400)
    const expiredSetup = app.jwt.sign({ purpose: 'two-factor-setup', userId: user.id, encryptedSecret: encrypt(setupBody.secret) }, { expiresIn: '-1s' })
    assert.equal((await app.inject({ method: 'POST', url: '/auth/2fa/enable', headers: primary, payload: { setupToken: expiredSetup, code: generateTotpCode(setupBody.secret) } })).statusCode, 400)

    const enabled = await app.inject({
      method: 'POST', url: '/auth/2fa/enable', headers: primary,
      payload: { setupToken: setupBody.setupToken, code: generateTotpCode(setupBody.secret) },
    })
    assert.equal(enabled.statusCode, 200)
    const recoveryCodes = enabled.json().recoveryCodes as string[]
    assert.equal(recoveryCodes.length, 8)
    assert.equal((await app.inject({ url: '/auth/session', headers: otherSession })).statusCode, 401)

    const stored = (await db.select().from(users).where(eq(users.id, user.id)))[0]!
    assert.notEqual(stored.totpSecret, setupBody.secret)
    assert.ok(stored.totpSecret)
    assert.equal(stored.totpRecoveryCodes?.includes(recoveryCodes[0]!), false)

    assert.equal((await app.inject({ method: 'POST', url: '/auth/logout', headers: primary })).statusCode, 204)
    const totpLogin = await login(user.email)
    assert.equal(totpLogin.json().requiresTwoFactor, true)
    const totpSession = await app.inject({
      method: 'POST', url: '/auth/2fa/verify',
      payload: { challengeToken: totpLogin.json().challengeToken, code: generateTotpCode(setupBody.secret) },
    })
    assert.equal(totpSession.statusCode, 200)
    const totpHeaders = sessionHeaders(totpSession)

    const invalidChallenge = app.jwt.sign({ purpose: 'wrong-purpose', userId: user.id })
    assert.equal((await app.inject({ method: 'POST', url: '/auth/2fa/verify', payload: { challengeToken: invalidChallenge, code: generateTotpCode(setupBody.secret) } })).statusCode, 401)
    const expiredChallenge = app.jwt.sign({ purpose: 'two-factor-login', userId: user.id }, { expiresIn: '-1s' })
    assert.equal((await app.inject({ method: 'POST', url: '/auth/2fa/verify', payload: { challengeToken: expiredChallenge, code: generateTotpCode(setupBody.secret) } })).statusCode, 401)

    const recoveryLogin = await login(user.email)
    const recoveryRequests = await Promise.all([
      app.inject({ method: 'POST', url: '/auth/2fa/verify', payload: { challengeToken: recoveryLogin.json().challengeToken, code: recoveryCodes[0] } }),
      app.inject({ method: 'POST', url: '/auth/2fa/verify', payload: { challengeToken: recoveryLogin.json().challengeToken, code: recoveryCodes[0] } }),
    ])
    assert.deepEqual(recoveryRequests.map((response) => response.statusCode).sort(), [200, 401])
    const recoverySession = recoveryRequests.find((response) => response.statusCode === 200)!
    const recoveryHeaders = sessionHeaders(recoverySession)
    const reuseLogin = await login(user.email)
    assert.equal((await app.inject({ method: 'POST', url: '/auth/2fa/verify', payload: { challengeToken: reuseLogin.json().challengeToken, code: recoveryCodes[0] } })).statusCode, 401)

    assert.equal((await app.inject({
      method: 'POST', url: '/auth/2fa/disable', headers: recoveryHeaders,
      payload: { currentPassword: 'wrong-password', code: generateTotpCode(setupBody.secret) },
    })).statusCode, 400)
    assert.equal((await app.inject({
      method: 'POST', url: '/auth/2fa/disable', headers: recoveryHeaders,
      payload: { currentPassword: password, code: generateTotpCode(setupBody.secret) },
    })).statusCode, 200)
    assert.equal((await app.inject({ url: '/auth/session', headers: recoveryHeaders })).json().twoFactorEnabled, false)
    assert.equal((await app.inject({ url: '/auth/session', headers: totpHeaders })).statusCode, 401)
    const disabled = (await db.select().from(users).where(eq(users.id, user.id)))[0]!
    assert.equal(disabled.totpEnabled, 0)
    assert.equal(disabled.totpSecret, null)
    assert.equal(disabled.totpRecoveryCodes, null)
    assert.equal((await login(user.email)).json().requiresTwoFactor, undefined)
  })

  it('preserves 2FA when the user changes their own password', async () => {
    const user = await createUser('password-with-two-factor@example.test')
    const headers = sessionHeaders(await login(user.email))
    const secret = generateTotpSecret()
    const storedSecret = encrypt(secret)
    const storedRecoveryCodes = JSON.stringify(generateRecoveryCodes().map(hashRecoveryCode))
    await db.update(users).set({
      totpEnabled: 1,
      totpSecret: storedSecret,
      totpRecoveryCodes: storedRecoveryCodes,
    }).where(eq(users.id, user.id))

    const changed = await app.inject({
      method: 'POST', url: '/auth/change-password', headers,
      payload: { currentPassword: password, newPassword: 'changed-with-two-factor' },
    })
    assert.equal(changed.statusCode, 200)
    assert.equal(changed.json().twoFactorEnabled, true)
    const afterChange = (await db.select().from(users).where(eq(users.id, user.id)))[0]!
    assert.equal(afterChange.totpEnabled, 1)
    assert.equal(afterChange.totpSecret, storedSecret)
    assert.equal(afterChange.totpRecoveryCodes, storedRecoveryCodes)
    assert.equal((await login(user.email, 'changed-with-two-factor')).json().requiresTwoFactor, true)
  })

  it('revokes target sessions on administration changes and preserves 2FA during password reset', async () => {
    const admin = await createUser('security-admin@example.test', 'admin')
    const adminHeaders = sessionHeaders(await login(admin.email))
    const target = await createUser('managed-user@example.test', 'operator')
    const secret = generateTotpSecret()
    const recoveryCodes = generateRecoveryCodes().map(hashRecoveryCode)
    await db.update(users).set({
      totpEnabled: 1,
      totpSecret: encrypt(secret),
      totpRecoveryCodes: JSON.stringify(recoveryCodes),
    }).where(eq(users.id, target.id))

    const roleChallenge = (await login(target.email)).json().challengeToken
    const roleVerified = await app.inject({ method: 'POST', url: '/auth/2fa/verify', payload: { challengeToken: roleChallenge, code: generateTotpCode(secret) } })
    const authenticatedRoleSession = sessionHeaders(roleVerified)
    assert.equal((await app.inject({ method: 'PATCH', url: `/admin/users/${target.id}/role`, headers: adminHeaders, payload: { role: 'branding' } })).statusCode, 200)
    assert.equal((await app.inject({ url: '/auth/session', headers: authenticatedRoleSession })).statusCode, 401)
    const resetChallenge = (await login(target.email)).json().challengeToken
    const resetVerified = await app.inject({ method: 'POST', url: '/auth/2fa/verify', payload: { challengeToken: resetChallenge, code: generateTotpCode(secret) } })
    const resetSession = sessionHeaders(resetVerified)
    const beforeReset = (await db.select().from(users).where(eq(users.id, target.id)))[0]!
    const reset = await app.inject({ method: 'POST', url: `/admin/users/${target.id}/reset-password`, headers: adminHeaders })
    assert.equal(reset.statusCode, 200)
    assert.equal((await app.inject({ url: '/auth/session', headers: resetSession })).statusCode, 401)
    const afterReset = (await db.select().from(users).where(eq(users.id, target.id)))[0]!
    assert.equal(afterReset.totpEnabled, 1)
    assert.equal(afterReset.totpSecret, beforeReset.totpSecret)
    assert.equal(afterReset.totpRecoveryCodes, beforeReset.totpRecoveryCodes)
    assert.equal((await login(target.email, reset.json().temporaryPassword)).json().requiresTwoFactor, true)

    const deleteChallenge = (await login(target.email, reset.json().temporaryPassword)).json().challengeToken
    const deleteVerified = await app.inject({ method: 'POST', url: '/auth/2fa/verify', payload: { challengeToken: deleteChallenge, code: generateTotpCode(secret) } })
    const deleteSession = sessionHeaders(deleteVerified)
    assert.equal((await app.inject({ method: 'DELETE', url: `/admin/users/${target.id}`, headers: adminHeaders })).statusCode, 200)
    assert.equal((await app.inject({ url: '/auth/session', headers: deleteSession })).statusCode, 401)
  })
})
