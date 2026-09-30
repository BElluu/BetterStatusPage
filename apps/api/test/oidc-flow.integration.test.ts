import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import cookie from '@fastify/cookie'
import jwt from '@fastify/jwt'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { encrypt } from '../src/crypto/vault.js'
import { generateTotpCode, generateTotpSecret } from '../src/crypto/totp.js'
import { db } from '../src/db/client.js'
import { auditLog, authSessions, oidcSettings, users } from '../src/db/schema.js'
import { requireAuth, requireRole } from '../src/middleware/auth.js'
import { authRoutes } from '../src/routes/auth.js'
import { oidcSettingsRoutes } from '../src/routes/oidcSettings.js'
import { userRoutes } from '../src/routes/users.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-oidc-flow-test-')
process.env['VAULT_ENCRYPTION_KEY'] = 'abcdef0123456789'.repeat(4)
for (const name of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_FORCE_PASSWORD_LOGIN']) delete process.env[name]

const CLIENT_ID = 'bsp'
const password = 'correct-password'

// ── A minimal OpenID provider: discovery, JWKS, token endpoint. The test plays the browser at /authorize. ──
const idp = Fastify({ logger: false })
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const kid = 'test-key'
const pendingCodes = new Map<string, Record<string, unknown>>()
let issuer = ''

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url')
function idToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))
  const payload = b64url(JSON.stringify({ iss: issuer, aud: CLIENT_ID, iat: now, exp: now + 300, ...claims }))
  return `${header}.${payload}.${b64url(sign('sha256', Buffer.from(`${header}.${payload}`), privateKey))}`
}

const app = Fastify({ logger: false })
type InjectResponse = Awaited<ReturnType<typeof app.inject>>

function cookiesFrom(response: InjectResponse): string[] {
  const raw = response.headers['set-cookie']
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).map((value) => value.split(';', 1)[0]!)
}

let admin: Record<string, string>

before(async () => {
  idp.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)))
  })
  idp.get('/.well-known/openid-configuration', async () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
  }))
  idp.get('/jwks', async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] }))
  idp.post<{ Body: { code?: string } }>('/token', async (req, reply) => {
    const claims = pendingCodes.get(req.body.code ?? '')
    if (!claims) return reply.code(400).send({ error: 'invalid_grant' })
    pendingCodes.delete(req.body.code!)
    return { access_token: randomUUID(), token_type: 'Bearer', expires_in: 300, id_token: idToken(claims) }
  })
  issuer = (await idp.listen({ port: 0, host: '127.0.0.1' })).replace('localhost', '127.0.0.1')

  initTestDb()
  await app.register(jwt, { secret: 'integration-secret-with-sufficient-entropy' })
  await app.register(cookie)
  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(async (protectedApp) => {
    protectedApp.addHook('preHandler', requireAuth)
    protectedApp.register(async (adminApp) => {
      adminApp.addHook('preHandler', requireRole())
      adminApp.register(oidcSettingsRoutes, { prefix: '/oidc' })
      adminApp.register(userRoutes, { prefix: '/users' })
    })
  }, { prefix: '/admin' })
  await app.ready()

  const passwordHash = await bcrypt.hash(password, 4)
  await db.insert(users).values([
    { email: 'admin@example.test', passwordHash, role: 'admin', createdAt: Date.now() },
    { email: 'alice@example.test', passwordHash, role: 'operator', mustChangePassword: 1, createdAt: Date.now() },
    { email: 'entra@example.test', passwordHash, role: 'operator', createdAt: Date.now() },
  ])
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@example.test', password } })
  const cookies = cookiesFrom(login)
  admin = { cookie: cookies.join('; '), 'x-csrf-token': cookies.find((c) => c.startsWith('bsp_csrf='))!.slice('bsp_csrf='.length) }

  await db.insert(oidcSettings).values({
    id: 1, enabled: 1, issuer, clientId: CLIENT_ID, clientSecret: '', scopes: '', redirectUri: 'http://127.0.0.1/api/v1/auth/oidc/callback',
    buttonLabel: '', allowUnverifiedEmail: 0, disablePasswordLogin: 0, updatedAt: Date.now(),
  })
})

after(async () => {
  await app.close()
  await idp.close()
  teardownTestDb(testDb)
})

/**
 * Plays the browser: starts at `start`, follows the redirect to the provider, which "authenticates" the user
 * with `claims`, and comes back to the callback with the flow cookie.
 */
async function runFlow(claims: Record<string, unknown> | { error: string }, start = '/auth/oidc/login', headers: Record<string, string> = {}) {
  const begin = await app.inject({ url: start, headers })
  assert.equal(begin.statusCode, 302)
  const authorize = new URL(begin.headers.location!)
  assert.equal(`${authorize.origin}${authorize.pathname}`, `${issuer}/authorize`)
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
  const state = authorize.searchParams.get('state')!
  const query = new URLSearchParams({ state })
  if ('error' in claims) {
    query.set('error', claims.error)
  } else {
    const code = randomUUID()
    pendingCodes.set(code, { ...claims, nonce: authorize.searchParams.get('nonce') })
    query.set('code', code)
  }
  const flowCookie = cookiesFrom(begin).find((c) => c.startsWith('bsp_oidc_flow='))!
  return app.inject({ url: `/auth/oidc/callback?${query}`, headers: { cookie: [headers['cookie'], flowCookie].filter(Boolean).join('; ') } })
}

const lastDenial = async () => {
  const entries = (await db.select().from(auditLog)).filter((entry) => entry.entityType === 'sign_in' && entry.action === 'deny')
  return JSON.parse(entries.at(-1)?.diff ?? '{}') as { code?: string; reason?: string }
}
const userByEmail = async (email: string) => (await db.select().from(users).where(eq(users.email, email)))[0]!

describe('OIDC sign-in flow', () => {
  it('signs in by verified email on first use and links the identity', async () => {
    const response = await runFlow({ sub: 'alice-sub', email: 'Alice@Example.test', email_verified: true })
    assert.equal(response.headers.location, '/admin/')
    assert.ok(cookiesFrom(response).some((c) => c.startsWith('bsp_session=')))

    const alice = await userByEmail('alice@example.test')
    assert.equal(alice.oidcIssuer, issuer)
    assert.equal(alice.oidcSubject, 'alice-sub')
    const audit = await db.select().from(auditLog)
    assert.ok(audit.some((entry) => entry.userEmail === 'alice@example.test' && (entry.diff ?? '').includes('ssoLinked')))
  })

  it('matches a linked identity by subject even when the email changes', async () => {
    const response = await runFlow({ sub: 'alice-sub', email: 'alice.new@example.test', email_verified: false })
    assert.equal(response.headers.location, '/admin/')
  })

  it('refuses another identity that claims the email of a linked user', async () => {
    const response = await runFlow({ sub: 'someone-else', email: 'alice@example.test', email_verified: true })
    assert.equal(response.headers.location, '/admin/login?error=oidc_no_account')
    assert.equal(cookiesFrom(response).some((c) => c.startsWith('bsp_session=')), false)
    assert.equal((await lastDenial()).code, 'subject_mismatch')
  })

  it('accepts Microsoft Entra ID xms_edov in place of email_verified', async () => {
    const response = await runFlow({ sub: 'entra-sub', email: 'entra@example.test', xms_edov: true })
    assert.equal(response.headers.location, '/admin/')
  })

  it('refuses an unverified email and an unknown user', async () => {
    assert.equal((await runFlow({ sub: 'x1', email: 'admin@example.test', email_verified: false })).headers.location, '/admin/login?error=oidc_no_account')
    assert.equal((await lastDenial()).code, 'email_not_verified')
    assert.equal((await runFlow({ sub: 'x2', email: 'nobody@example.test', email_verified: true })).headers.location, '/admin/login?error=oidc_no_account')
    assert.equal((await lastDenial()).code, 'no_matching_account')
  })

  it('audits an error returned by the provider', async () => {
    const response = await runFlow({ error: 'access_denied' })
    assert.equal(response.headers.location, '/admin/login?error=oidc_failed')
    const denial = await lastDenial()
    assert.equal(denial.code, 'idp_error')
    assert.match(denial.reason ?? '', /access_denied/)
  })
})

describe('OIDC test sign-in', () => {
  it('reports the outcome to the administrator without signing in or linking', async () => {
    const response = await runFlow({ sub: 'admin-sub', email: 'admin@example.test', email_verified: true }, '/admin/oidc/test-sign-in', { cookie: admin['cookie']! })
    const location = new URL(response.headers.location!, 'http://localhost')
    assert.equal(location.pathname, '/admin/sso-test')
    assert.equal(cookiesFrom(response).some((c) => c.startsWith('bsp_session=')), false)
    assert.equal((await userByEmail('admin@example.test')).oidcSubject, null)

    const result = await app.inject({ url: `/admin/oidc/test-sign-in/${location.searchParams.get('result')}`, headers: admin })
    assert.equal(result.statusCode, 200)
    assert.equal(result.json().outcome, 'link')
    assert.equal(result.json().user, 'admin@example.test')
    assert.equal(result.json().claims.sub, 'admin-sub')

    const unknown = await app.inject({ url: `/admin/oidc/test-sign-in/${randomUUID()}`, headers: admin })
    assert.equal(unknown.statusCode, 404)
  })

  it('is admin only', async () => {
    assert.equal((await app.inject({ url: '/admin/oidc/test-sign-in' })).statusCode, 401)
  })
})

describe('Temporary password of an SSO user', () => {
  it('is revoked by the SSO sign-in, even with password sign-in enabled', async () => {
    // Alice had a temporary password and signed in through SSO in the first test.
    const alice = ((await app.inject({ url: '/admin/users', headers: admin })).json() as Array<{ email: string; pendingTemporaryPassword: boolean; ssoLinked: boolean }>)
      .find((user) => user.email === 'alice@example.test')!
    assert.equal(alice.ssoLinked, true)
    assert.equal(alice.pendingTemporaryPassword, false)

    const withTemporary = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'alice@example.test', password } })
    assert.equal(withTemporary.statusCode, 401)
    const audit = await db.select().from(auditLog)
    assert.ok(audit.some((entry) => entry.userEmail === 'alice@example.test' && (entry.diff ?? '').includes('temporaryPasswordRevoked')))
  })
})

/** Session headers (cookie + CSRF) from a response that signed someone in. */
function sessionHeaders(response: InjectResponse): Record<string, string> {
  const cookies = cookiesFrom(response).filter((c) => c.startsWith('bsp_session=') || c.startsWith('bsp_csrf='))
  return { cookie: cookies.join('; '), 'x-csrf-token': cookies.find((c) => c.startsWith('bsp_csrf='))!.slice('bsp_csrf='.length) }
}

describe('Two-factor authentication after SSO', () => {
  it('asks a user with 2FA for their code before the SSO session starts', async () => {
    const secret = generateTotpSecret()
    await db.insert(users).values({
      email: 'totp@example.test', passwordHash: await bcrypt.hash(password, 4), role: 'operator',
      totpEnabled: 1, totpSecret: encrypt(secret), createdAt: Date.now(),
    })
    const callback = await runFlow({ sub: 'totp-sub', email: 'totp@example.test', email_verified: true })
    assert.equal(callback.headers.location, '/admin/login?two-factor=sso')
    assert.equal(cookiesFrom(callback).some((c) => c.startsWith('bsp_session=')), false)
    const challenge = cookiesFrom(callback).find((c) => c.startsWith('bsp_2fa_challenge='))!

    const wrong = await app.inject({ method: 'POST', url: '/auth/2fa/verify', headers: { cookie: challenge }, payload: { code: '000000' } })
    assert.equal(wrong.statusCode, 401)
    const verified = await app.inject({ method: 'POST', url: '/auth/2fa/verify', headers: { cookie: challenge }, payload: { code: generateTotpCode(secret) } })
    assert.equal(verified.statusCode, 200)
    assert.equal(verified.json().authMethod, 'oidc')
    assert.equal(verified.json().twoFactorEnabled, true)

    const signIns = (await db.select().from(auditLog)).filter((entry) => entry.entityType === 'sign_in' && entry.userEmail === 'totp@example.test')
    assert.deepEqual(signIns.map((entry) => [entry.action, JSON.parse(entry.diff ?? '{}')]), [
      ['deny', { method: 'sso', code: 'invalid_two_factor_code', reason: 'The authentication or recovery code is incorrect.' }],
      ['allow', { method: 'sso', twoFactor: true }],
    ])
    const expired = await app.inject({ method: 'POST', url: '/auth/2fa/verify', payload: { code: generateTotpCode(secret) } })
    assert.equal(expired.statusCode, 401)
    assert.equal((await lastDenial()).code, 'two_factor_expired')
  })
})

describe('Confirming sensitive actions in an SSO session', () => {
  let sso: Record<string, string>
  let ssoAdminId = 0
  const ssoClaims = { sub: 'sso-admin-sub', email: 'sso-admin@example.test', email_verified: true }
  const settingsPayload = () => ({ enabled: true, issuer, clientId: CLIENT_ID, redirectUri: 'http://127.0.0.1/api/v1/auth/oidc/callback' })
  const expireConfirmation = () => db.update(authSessions).set({ verifiedAt: Date.now() - 11 * 60_000 }).where(eq(authSessions.userId, ssoAdminId))

  before(async () => {
    ssoAdminId = (await db.insert(users).values({
      email: 'sso-admin@example.test', passwordHash: await bcrypt.hash('unknown-to-the-user', 4), role: 'admin', createdAt: Date.now(),
    }).returning())[0]!.id
    sso = sessionHeaders(await runFlow(ssoClaims))
  })

  it('accepts a fresh SSO sign-in instead of a password', async () => {
    const saved = await app.inject({ method: 'PUT', url: '/admin/oidc', headers: sso, payload: settingsPayload() })
    assert.equal(saved.statusCode, 200)
  })

  it('asks for an SSO confirmation once the sign-in is older than the window, then accepts it', async () => {
    await expireConfirmation()
    const refused = await app.inject({ method: 'PUT', url: '/admin/oidc', headers: sso, payload: { ...settingsPayload(), currentPassword: 'unknown-to-the-user' } })
    assert.equal(refused.statusCode, 403)
    assert.equal(refused.json().code, 'SSO_CONFIRMATION_REQUIRED')

    const begin = await app.inject({ url: '/auth/oidc/confirm', headers: { cookie: sso['cookie']! } })
    const authorize = new URL(begin.headers.location!)
    assert.equal(authorize.searchParams.get('prompt'), 'login')
    assert.equal(authorize.searchParams.get('max_age'), '300')
    const confirmed = await runFlow({ ...ssoClaims, auth_time: Math.floor(Date.now() / 1000) }, '/auth/oidc/confirm', { cookie: sso['cookie']! })
    assert.equal(confirmed.headers.location, '/admin/sso-confirm?status=ok')

    const saved = await app.inject({ method: 'PUT', url: '/admin/oidc', headers: sso, payload: settingsPayload() })
    assert.equal(saved.statusCode, 200)
  })

  it('refuses a confirmation without a fresh auth_time or by another user', async () => {
    await expireConfirmation()
    const stale = await runFlow({ ...ssoClaims, auth_time: Math.floor(Date.now() / 1000) - 3600 }, '/auth/oidc/confirm', { cookie: sso['cookie']! })
    assert.equal(stale.headers.location, '/admin/sso-confirm?status=failed')
    const missing = await runFlow(ssoClaims, '/auth/oidc/confirm', { cookie: sso['cookie']! })
    assert.equal(missing.headers.location, '/admin/sso-confirm?status=failed')
    const other = await runFlow({ sub: 'alice-sub', email: 'alice@example.test', email_verified: true, auth_time: Math.floor(Date.now() / 1000) }, '/auth/oidc/confirm', { cookie: sso['cookie']! })
    assert.equal(other.headers.location, '/admin/sso-confirm?status=failed')
    assert.equal((await lastDenial()).code, 'confirmation_mismatch')

    const refused = await app.inject({ method: 'PUT', url: '/admin/oidc', headers: sso, payload: settingsPayload() })
    assert.equal(refused.statusCode, 403)
  })

  it('does not confirm a password session through SSO', async () => {
    const begin = await app.inject({ url: '/auth/oidc/confirm', headers: { cookie: admin['cookie']! } })
    assert.equal(begin.headers.location, '/admin/sso-confirm?status=failed')
    const refused = await app.inject({ method: 'PUT', url: '/admin/oidc', headers: admin, payload: settingsPayload() })
    assert.equal(refused.statusCode, 400)
  })

  it('lets an SSO user set up 2FA and set a password with the SSO confirmation', async () => {
    const fresh = sessionHeaders(await runFlow(ssoClaims))
    const setup = await app.inject({ method: 'POST', url: '/auth/2fa/setup', headers: fresh, payload: {} })
    assert.equal(setup.statusCode, 200)
    const changed = await app.inject({ method: 'POST', url: '/auth/change-password', headers: fresh, payload: { newPassword: 'chosen-by-sso-user' } })
    assert.equal(changed.statusCode, 200)
    assert.equal(changed.json().authMethod, 'oidc')
  })
})
