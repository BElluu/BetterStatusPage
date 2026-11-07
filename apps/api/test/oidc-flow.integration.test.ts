import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import cookie from '@fastify/cookie'
import jwt from '@fastify/jwt'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { encrypt } from '../src/kit/secretBox.js'
import { generateTotpCode, generateTotpSecret } from '@better-forge/auth'
import { db } from '../src/db/client.js'
import { auditLog, authSessions, oidcSettings, users } from '../src/db/schema.js'
import { requireAuth, requireRole } from '../src/kit/authMiddleware.js'
import { authRoutes } from '../src/kit/authRoutes.js'
import { oidcSettingsRoutes } from '../src/kit/oidcSettingsRoutes.js'
import { adminSsoProvisioningRoutes } from '../src/routes/ssoProvisioning.js'
import { getSsoProvisioning, saveSsoProvisioning } from '../src/services/ssoProvisioning.js'
import { userRoutes } from '../src/kit/userRoutes.js'
import type { SsoProvisioningSettings } from '@bsp/shared'
import { saveStatusPageAccess } from '../src/services/statusPageAccess.js'
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
      adminApp.register(adminSsoProvisioningRoutes, { prefix: '/sso-provisioning' })
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
    query.set('error', String(claims.error))
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

describe('SSO sign-in to a private status page', () => {
  after(async () => { await saveStatusPageAccess({}) })

  it('returns to the status page when the sign-in started there', async () => {
    await db.insert(users).values({ email: 'returning@example.test', passwordHash: 'unused', role: 'operator', createdAt: Date.now() })
    const response = await runFlow({ sub: 'returning-sub', email: 'returning@example.test', email_verified: true }, '/auth/oidc/login?returnTo=status')
    assert.equal(response.headers.location, '/')
    assert.ok(cookiesFrom(response).some((c) => c.startsWith('bsp_session=')))

    const refused = await runFlow({ sub: 'stranger-sub', email: 'stranger@example.test', email_verified: true }, '/auth/oidc/login?returnTo=status')
    assert.equal(refused.headers.location, '/?sign-in-error=oidc_no_account')
  })

  it('returns to the status page at PUBLIC_URL, which may be another origin than the callback', async () => {
    process.env['PUBLIC_URL'] = 'https://status.example.test/'
    try {
      const refused = await runFlow({ sub: 'stranger-sub', email: 'stranger@example.test', email_verified: true }, '/auth/oidc/login?returnTo=status')
      assert.equal(refused.headers.location, 'https://status.example.test/?sign-in-error=oidc_no_account')
      const signedIn = await runFlow({ sub: 'returning-sub', email: 'returning@example.test', email_verified: true }, '/auth/oidc/login?returnTo=status')
      assert.equal(signedIn.headers.location, 'https://status.example.test/')
      // Without returnTo an operator still goes to the admin console.
      assert.equal((await runFlow({ sub: 'returning-sub', email: 'returning@example.test', email_verified: true })).headers.location, '/admin/')
    } finally {
      delete process.env['PUBLIC_URL']
    }
  })

  it('creates a viewer account for an allowed domain only while the page is private', async () => {
    await saveStatusPageAccess({ private: false, ssoCreateViewers: true, ssoViewerDomains: ['viewers.test'] })
    const whilePublic = await runFlow({ sub: 'early-sub', email: 'early@viewers.test', email_verified: true })
    assert.equal(whilePublic.headers.location, '/admin/login?error=oidc_no_account')

    await saveStatusPageAccess({ private: true, ssoCreateViewers: true, ssoViewerDomains: ['viewers.test'] })
    const otherDomain = await runFlow({ sub: 'outsider-sub', email: 'outsider@elsewhere.test', email_verified: true })
    assert.equal(otherDomain.headers.location, '/admin/login?error=oidc_no_account')
    const unverified = await runFlow({ sub: 'unverified-sub', email: 'unverified@viewers.test', email_verified: false })
    assert.equal(unverified.headers.location, '/admin/login?error=oidc_no_account')

    // A viewer has nothing to do in the admin console, so they land on the status page wherever they started.
    const created = await runFlow({ sub: 'viewer-sub', email: 'Viewer@Viewers.test', email_verified: true })
    assert.equal(created.headers.location, '/')
    assert.ok(cookiesFrom(created).some((c) => c.startsWith('bsp_session=')))
    const viewer = await userByEmail('viewer@viewers.test')
    assert.equal(viewer.role, 'viewer')
    assert.equal(viewer.oidcIssuer, issuer)
    assert.equal(viewer.oidcSubject, 'viewer-sub')
    assert.equal(viewer.mustChangePassword, 0)
    const audit = (await db.select().from(auditLog)).filter((entry) => entry.entityType === 'user' && entry.action === 'create')
    assert.ok(audit.some((entry) => entry.userEmail === 'viewer@viewers.test' && (entry.diff ?? '').includes('"createdBy":"sso"')))

    // The next sign-in matches the bound identity instead of creating another account.
    assert.equal((await runFlow({ sub: 'viewer-sub', email: 'viewer@viewers.test', email_verified: true })).headers.location, '/')
    assert.equal((await db.select().from(users).where(eq(users.email, 'viewer@viewers.test'))).length, 1)
  })

  it('reports a would-be viewer account in the test sign-in without creating it', async () => {
    await saveStatusPageAccess({ private: true, ssoCreateViewers: true, ssoViewerDomains: ['viewers.test'] })
    const response = await runFlow({ sub: 'tested-sub', email: 'tested@viewers.test', email_verified: true }, '/admin/oidc/test-sign-in', { cookie: admin['cookie']! })
    const location = new URL(response.headers.location!, 'http://localhost')
    const result = await app.inject({ url: `/admin/oidc/test-sign-in/${location.searchParams.get('result')}`, headers: admin })
    assert.equal(result.json().outcome, 'provision')
    assert.equal(result.json().user, 'tested@viewers.test')
    assert.equal((await db.select().from(users).where(eq(users.email, 'tested@viewers.test'))).length, 0)
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

describe('SSO account creation from the admin panel', () => {
  const settings: SsoProvisioningSettings = {
    enabled: true,
    allowedDomains: ['corp.test'],
    groupsClaim: 'groups',
    groupRoles: [{ group: 'Technicians', role: 'admin' }, { group: 'Operators', role: 'operator' }, { group: 'Domain Users', role: 'viewer' }],
  }
  const signUp = (name: string, extra: Record<string, unknown> = {}, start?: string) =>
    runFlow({ sub: `${name}-sub`, email: `${name}@corp.test`, email_verified: true, ...extra }, start)

  after(async () => {
    await saveSsoProvisioning({ enabled: false, allowedDomains: [], groupsClaim: 'groups', groupRoles: [] })
    await saveStatusPageAccess({})
  })

  it('creates nobody while it is off', async () => {
    await saveSsoProvisioning({ ...settings, enabled: false })
    const response = await signUp('off', { groups: ['Technicians'] })
    assert.equal(response.headers.location, '/admin/login?error=oidc_no_account')
  })

  it('gives the highest role of the mapped groups, admin included', async () => {
    await saveSsoProvisioning(settings)
    assert.equal((await signUp('boss', { groups: ['Domain Users', 'Technicians', 'other'] })).headers.location, '/admin/')
    assert.equal((await userByEmail('boss@corp.test')).role, 'admin')
    // The audit log says which role the account was created with and which rule gave it.
    const created = (await db.select().from(auditLog)).find((entry) => entry.entityType === 'user' && entry.action === 'create' && entry.userEmail === 'boss@corp.test')
    assert.deepEqual(JSON.parse(created!.diff!), {
      email: 'boss@corp.test', role: 'admin', createdBy: 'sso', issuer, rule: 'Group mapping, domain corp.test: Technicians (admin), Domain Users (viewer)',
    })
    await signUp('worker', { groups: ['Operators', 'Domain Users'] })
    assert.equal((await userByEmail('worker@corp.test')).role, 'operator')
    const reader = await signUp('reader', { groups: ['Domain Users'] })
    assert.equal((await userByEmail('reader@corp.test')).role, 'viewer')
    assert.equal(reader.headers.location, '/')
  })

  it('refuses a person without a mapped group, a groups claim that is not a list, another domain or an unvouched email', async () => {
    await saveSsoProvisioning(settings)
    const refused = '/admin/login?error=oidc_no_account'
    assert.equal((await signUp('nogroup', { groups: ['unmapped'] })).headers.location, refused)
    assert.equal((await signUp('noclaim')).headers.location, refused)
    assert.equal((await signUp('textclaim', { groups: 'Technicians' })).headers.location, refused)
    assert.equal((await signUp('caseclaim', { groups: ['technicians'] })).headers.location, refused)
    assert.equal((await runFlow({ sub: 'x-sub', email: 'x@elsewhere.test', email_verified: true, groups: ['Technicians'] })).headers.location, refused)
    assert.equal((await signUp('unverified', { groups: ['Technicians'], email_verified: false })).headers.location, refused)
    assert.equal((await db.select().from(users).where(eq(users.email, 'nogroup@corp.test'))).length, 0)
  })

  it('reads the claim the settings name', async () => {
    await saveSsoProvisioning({ ...settings, groupsClaim: 'roles' })
    await signUp('custom', { groups: ['Technicians'], roles: ['Operators'] })
    assert.equal((await userByEmail('custom@corp.test')).role, 'operator')
  })

  it('never gives more than a viewer to a sign-in that started on the status page', async () => {
    await saveSsoProvisioning(settings)
    // Not private: nothing is created, whatever the groups say.
    assert.equal((await signUp('page1', { groups: ['Technicians'] }, '/auth/oidc/login?returnTo=status')).headers.location, '/?sign-in-error=oidc_no_account')
    await saveStatusPageAccess({ private: true, ssoCreateViewers: true, ssoViewerDomains: ['corp.test'] })
    await signUp('page2', { groups: ['Technicians'] }, '/auth/oidc/login?returnTo=status')
    assert.equal((await userByEmail('page2@corp.test')).role, 'viewer')
    const viewerAudit = (await db.select().from(auditLog)).find((entry) => entry.action === 'create' && entry.userEmail === 'page2@corp.test')
    assert.equal(JSON.parse(viewerAudit!.diff!).rule, 'Status page access, domain corp.test')
    // Groups are not needed there.
    await signUp('page3', {}, '/auth/oidc/login?returnTo=status')
    assert.equal((await userByEmail('page3@corp.test')).role, 'viewer')
    await saveStatusPageAccess({})
  })

  it('does not ask for more than the sign-in settings do about the email, and falls back to a viewer where the page allows it', async () => {
    await saveSsoProvisioning(settings)
    // Entra ID sends neither claim by default: it is accepted only where the SSO settings accept providers that omit them.
    assert.equal((await signUp('noclaims', { groups: ['Operators'], email_verified: undefined })).headers.location, '/admin/login?error=oidc_no_account')
    await db.update(oidcSettings).set({ allowUnverifiedEmail: 1 })
    try {
      await signUp('noclaims', { groups: ['Operators'], email_verified: undefined })
      assert.equal((await userByEmail('noclaims@corp.test')).role, 'operator')
      // An email the provider reports as unverified is still refused.
      assert.equal((await signUp('reported', { groups: ['Operators'], email_verified: false })).headers.location, '/admin/login?error=oidc_no_account')
    } finally {
      await db.update(oidcSettings).set({ allowUnverifiedEmail: 0 })
    }
    await runFlow({ sub: 'entra2-sub', email: 'entra@corp.test', xms_edov: true, groups: ['Operators'] })
    assert.equal((await userByEmail('entra@corp.test')).role, 'operator')
    await runFlow({ sub: 'str-sub', email: 'str@corp.test', email_verified: 'true', groups: ['Operators'] })
    assert.equal((await userByEmail('str@corp.test')).role, 'operator')

    // No mapped group: nothing, unless the private page lets this domain in as a viewer.
    assert.equal((await signUp('fallback', { groups: ['unmapped'] })).headers.location, '/admin/login?error=oidc_no_account')
    await saveStatusPageAccess({ private: true, ssoCreateViewers: true, ssoViewerDomains: ['corp.test'] })
    assert.equal((await signUp('fallback', { groups: ['unmapped'] })).headers.location, '/')
    assert.equal((await userByEmail('fallback@corp.test')).role, 'viewer')
    await saveStatusPageAccess({})
  })

  it('does not read a groups claim that is not the token\'s own', async () => {
    await saveSsoProvisioning({ ...settings, groupsClaim: 'toString' })
    const response = await signUp('inherited', { groups: ['Technicians'] })
    assert.equal(response.headers.location, '/admin/login?error=oidc_no_account')
  })

  it('shows the role in the test sign-in without creating the account', async () => {
    await saveSsoProvisioning(settings)
    const response = await runFlow({ sub: 'try-sub', email: 'try@corp.test', email_verified: true, groups: ['Technicians'] }, '/admin/oidc/test-sign-in', { cookie: admin['cookie']! })
    const location = new URL(response.headers.location!, 'http://localhost')
    const result = (await app.inject({ url: `/admin/oidc/test-sign-in/${location.searchParams.get('result')}`, headers: admin })).json()
    assert.equal(result.outcome, 'provision')
    assert.equal(result.role, 'admin')
    assert.match(result.reason, /Technicians \(admin\)/)
    assert.equal((await db.select().from(users).where(eq(users.email, 'try@corp.test'))).length, 0)
  })
})

describe('SSO account creation settings', () => {
  const body = { enabled: true, allowedDomains: ['corp.test'], groupsClaim: 'groups', groupRoles: [{ group: 'Technicians', role: 'admin' }] }
  const put = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/admin/sso-provisioning', headers: admin, payload })
  after(async () => { await saveSsoProvisioning({ enabled: false, allowedDomains: [], groupsClaim: 'groups', groupRoles: [] }) })

  it('is confirmed with the password when it gives more, and then saved and audited', async () => {
    assert.equal((await put(body)).statusCode, 400)
    assert.equal((await put({ ...body, currentPassword: 'wrong' })).statusCode, 400)
    assert.equal((await getSsoProvisioning()).enabled, false)
    const saved = await put({ ...body, allowedDomains: [' @Corp.test '], currentPassword: password })
    assert.equal(saved.statusCode, 200)
    assert.deepEqual(saved.json().allowedDomains, ['corp.test'])
    const audit = (await db.select().from(auditLog)).filter((entry) => entry.entityType === 'sso_provisioning')
    assert.equal(audit.length, 1)
  })

  it('does not ask again to turn it down, but asks for a higher role', async () => {
    assert.equal((await put({ ...body, groupRoles: [{ group: 'Technicians', role: 'viewer' }] })).statusCode, 200)
    assert.equal((await put(body)).statusCode, 400)
    assert.equal((await put({ ...body, enabled: false })).statusCode, 200)
  })

  it('asks again for a new domain alone and for another claim alone, but not for fewer', async () => {
    assert.equal((await put({ ...body, currentPassword: password })).statusCode, 200)
    assert.equal((await put({ ...body, allowedDomains: ['corp.test', 'new.test'] })).statusCode, 400)
    assert.equal((await put({ ...body, groupsClaim: 'roles' })).statusCode, 400)
    assert.equal((await put({ ...body, allowedDomains: ['corp.test', 'new.test'], currentPassword: password })).statusCode, 200)
    assert.equal((await put({ ...body })).statusCode, 200)
    assert.deepEqual((await getSsoProvisioning()).allowedDomains, ['corp.test'])
  })

  it('stores group names without the spaces around them and sees "A" and "A " as one group', async () => {
    const saved = await put({ ...body, groupRoles: [{ group: '  Technicians ', role: 'admin' }], currentPassword: password })
    assert.deepEqual(saved.json().groupRoles, [{ group: 'Technicians', role: 'admin' }])
    const twice = await put({ ...body, groupRoles: [{ group: 'A', role: 'admin' }, { group: 'A ', role: 'viewer' }], currentPassword: password })
    assert.equal(twice.statusCode, 400)
  })

  it('refuses settings that would let anybody in or are malformed', async () => {
    const bad = async (payload: Record<string, unknown>) => (await put({ ...body, currentPassword: password, ...payload })).statusCode
    assert.equal(await bad({ allowedDomains: [] }), 400)
    assert.equal(await bad({ groupRoles: [] }), 400)
    assert.equal(await bad({ groupRoles: [{ group: 'a', role: 'root' }] }), 400)
    assert.equal(await bad({ groupRoles: [{ group: 'a', role: 'admin' }, { group: 'a', role: 'viewer' }] }), 400)
    assert.equal(await bad({ groupRoles: [{ group: '', role: 'admin' }] }), 400)
    assert.equal(await bad({ groupsClaim: 'not a claim!' }), 400)
    assert.equal(await bad({ groupsClaim: '__proto__' }), 400)
    assert.equal(await bad({ groupsClaim: 'constructor' }), 400)
    assert.equal(await bad({ allowedDomains: ['not a domain'] }), 400)
  })
})
