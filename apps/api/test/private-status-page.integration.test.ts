import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import cookie from '@fastify/cookie'
import jwt from '@fastify/jwt'
import bcrypt from 'bcryptjs'
import Fastify from 'fastify'
import { STATUS_PAGE_PRIVATE } from '@bsp/shared'
import { db } from '../src/db/client.js'
import { auditLog, branding, users } from '../src/db/schema.js'
import { requireAuth, requireRole } from '../src/middleware/auth.js'
import { authRoutes } from '../src/routes/auth.js'
import { feedRoutes } from '../src/routes/feeds.js'
import { publicRoutes } from '../src/routes/public.js'
import { statusApiRoutes } from '../src/routes/statusApi.js'
import { adminStatusPageAccessRoutes, publicStatusPageAccessRoutes } from '../src/routes/statusPageAccess.js'
import { adminSubscriberRoutes, publicSubscriptionRoutes } from '../src/routes/subscriptions.js'
import { userRoutes } from '../src/routes/users.js'
import { getMethodStatuses, getSubscriptionSettings, normalizeSubscriptionSettings, saveSubscriptionSettings } from '../src/services/subscriptions.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-private-page-test-')
for (const name of ['OIDC_ISSUER', 'OIDC_CLIENT_ID']) delete process.env[name]

const app = Fastify({ logger: false })
type InjectResponse = Awaited<ReturnType<typeof app.inject>>
const password = 'correct-password'
let admin: Record<string, string>
let viewer: Record<string, string>

function sessionHeaders(response: InjectResponse): Record<string, string> {
  const raw = response.headers['set-cookie']
  const cookies = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((value) => value.split(';', 1)[0]!)
  return { cookie: cookies.join('; '), 'x-csrf-token': cookies.find((c) => c.startsWith('bsp_csrf='))!.slice('bsp_csrf='.length) }
}

async function signIn(email: string): Promise<Record<string, string>> {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } })
  assert.equal(response.statusCode, 200)
  return sessionHeaders(response)
}

async function setAccess(body: Record<string, unknown>, headers = admin) {
  return app.inject({ method: 'PUT', url: '/api/v1/admin/status-page-access', headers, payload: body })
}

before(async () => {
  initTestDb()
  await app.register(jwt, { secret: 'integration-secret-with-sufficient-entropy' })
  await app.register(cookie)
  await app.register(authRoutes, { prefix: '/api/v1/auth' })
  await app.register(publicRoutes, { prefix: '/api/v1/public' })
  await app.register(publicStatusPageAccessRoutes, { prefix: '/api/v1/public' })
  await app.register(feedRoutes, { prefix: '/api/v1/public' })
  await app.register(statusApiRoutes, { prefix: '/api/v1/public' })
  await app.register(publicSubscriptionRoutes, { prefix: '/api/v1/public/subscriptions' })
  await app.register(async (adminApp) => {
    adminApp.addHook('preHandler', requireAuth)
    await adminApp.register(async (sub) => {
      sub.addHook('preHandler', requireRole('operator'))
      await sub.register(adminSubscriberRoutes, { prefix: '/subscribers' })
    })
    await adminApp.register(async (sub) => {
      sub.addHook('preHandler', requireRole())
      await sub.register(userRoutes, { prefix: '/users' })
      await sub.register(adminStatusPageAccessRoutes, { prefix: '/status-page-access' })
    })
  }, { prefix: '/api/v1/admin' })
  await app.ready()

  const passwordHash = await bcrypt.hash(password, 4)
  await db.insert(users).values([
    { email: 'admin@example.test', passwordHash, role: 'admin', createdAt: Date.now() },
    { email: 'viewer@example.test', passwordHash, role: 'viewer', createdAt: Date.now() },
    { email: 'fresh@example.test', passwordHash, role: 'viewer', mustChangePassword: 1, createdAt: Date.now() },
  ])
  await db.insert(branding).values({ id: 1, siteName: 'Acme Status', updatedAt: Date.now() })
  await saveSubscriptionSettings(normalizeSubscriptionSettings(
    { enabled: true, allowEmail: true, rssEnabled: true, allowSlack: true, apiEnabled: true },
    await getSubscriptionSettings(),
  ))
  admin = await signIn('admin@example.test')
  viewer = await signIn('viewer@example.test')
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

describe('A public status page', () => {
  it('answers everyone, and its feeds and API are on', async () => {
    const access = await app.inject({ url: '/api/v1/public/access' })
    assert.equal(access.statusCode, 200)
    assert.equal(access.headers['cache-control'], 'no-store')
    assert.deepEqual({ ...access.json(), branding: undefined }, {
      private: false, signedIn: false, email: null, role: null, passwordChangeRequired: false, branding: undefined,
    })
    const status = await app.inject({ url: '/api/v1/public/status' })
    assert.equal(status.statusCode, 200)
    assert.match(String(status.headers['cache-control']), /^public/)
    assert.equal(status.headers['x-robots-tag'], undefined)
    assert.equal((await app.inject({ url: '/api/v1/public/incidents.rss' })).statusCode, 200)
    assert.equal((await app.inject({ url: '/api/v1/public/summary.json' })).statusCode, 200)
    assert.equal((await app.inject({ url: '/api/v1/public/subscriptions/options' })).statusCode, 200)
  })
})

describe('Status page access settings', () => {
  it('are read and changed by administrators only, and every change is audited', async () => {
    const initial = await app.inject({ url: '/api/v1/admin/status-page-access', headers: admin })
    assert.deepEqual(initial.json(), { private: false, ssoCreateViewers: false, ssoViewerDomains: [], ssoConfigured: false })
    assert.equal((await setAccess({ private: true }, viewer)).statusCode, 403)

    const saved = await setAccess({ private: true, ssoCreateViewers: true, ssoViewerDomains: ['@Example.COM', 'example.com', ' sub.example.org ', ''] })
    assert.equal(saved.statusCode, 200)
    assert.deepEqual(saved.json(), { private: true, ssoCreateViewers: true, ssoViewerDomains: ['example.com', 'sub.example.org'], ssoConfigured: false })

    const entry = (await db.select().from(auditLog)).find((row) => row.entityType === 'status_page_access')
    assert.equal(entry?.userEmail, 'admin@example.test')
    assert.deepEqual(JSON.parse(entry!.diff!).private, { from: false, to: true })
  })

  it('refuse creating viewer accounts without a domain list, and anything that is not a domain', async () => {
    assert.match((await setAccess({ private: true, ssoCreateViewers: true, ssoViewerDomains: [] })).json().error, /at least one email domain/)
    assert.match((await setAccess({ private: true, ssoViewerDomains: ['not a domain'] })).json().error, /not a valid email domain/)
    assert.match((await setAccess({ private: true, ssoViewerDomains: 'example.com' })).json().error, /must be a list/)
    assert.equal((await setAccess({ private: true, ssoViewerDomains: Array.from({ length: 51 }, (_, i) => `d${i}.test`) })).statusCode, 400)
    assert.equal((await app.inject({ url: '/api/v1/admin/status-page-access', headers: admin })).json().ssoCreateViewers, true)
  })
})

describe('A private status page', () => {
  before(async () => { assert.equal((await setAccess({ private: true })).statusCode, 200) })

  it('asks visitors to sign in and keeps the branding for the sign-in screen', async () => {
    const access = (await app.inject({ url: '/api/v1/public/access' })).json()
    assert.equal(access.private, true)
    assert.equal(access.signedIn, false)
    assert.equal(access.branding.siteName, 'Acme Status')

    for (const url of ['/status', '/layout', '/incidents', '/incidents/1', '/monitor/1/uptime', '/events', '/subscriptions/options']) {
      const response = await app.inject({ url: `/api/v1/public${url}` })
      assert.equal(response.statusCode, 401, url)
      assert.equal(response.json().code, STATUS_PAGE_PRIVATE, url)
      assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow', url)
    }
    const signup = await app.inject({ method: 'POST', url: '/api/v1/public/subscriptions', payload: { type: 'email', email: 'x@example.test' } })
    assert.equal(signup.statusCode, 401)
  })

  it('switches off the feeds and the status API, which nothing outside the page can sign in to', async () => {
    for (const url of ['/incidents.rss', '/incidents.atom', '/slack.rss', '/summary.json', '/components.json']) {
      assert.equal((await app.inject({ url: `/api/v1/public${url}`, headers: viewer })).statusCode, 404, url)
    }
    const methods = await getMethodStatuses()
    assert.deepEqual(methods.rss.problems, ['private'])
    assert.equal(methods.api.available, false)
    assert.equal(methods.slack.available, false)
    const settings = (await app.inject({ url: '/api/v1/admin/subscribers/settings', headers: admin })).json()
    assert.equal(settings.statusPagePrivate, true)
  })

  it('keeps the links in subscriber emails working without a session', async () => {
    const confirm = await app.inject({ method: 'POST', url: '/api/v1/public/subscriptions/confirm', payload: { token: 'unknown' } })
    assert.notEqual(confirm.statusCode, 401)
  })

  it('shows signed-in users the page, kept out of shared caches', async () => {
    const access = (await app.inject({ url: '/api/v1/public/access', headers: viewer })).json()
    assert.equal(access.signedIn, true)
    assert.equal(access.email, 'viewer@example.test')
    assert.equal(access.role, 'viewer')

    const status = await app.inject({ url: '/api/v1/public/status', headers: viewer })
    assert.equal(status.statusCode, 200)
    assert.match(String(status.headers['cache-control']), /^private/)
    assert.equal(status.headers['x-robots-tag'], 'noindex, nofollow')
    assert.equal((await app.inject({ url: '/api/v1/public/layout', headers: viewer })).statusCode, 200)
    assert.equal((await app.inject({ url: '/api/v1/public/subscriptions/options', headers: viewer })).statusCode, 200)
  })

  it('requires a CSRF token to sign up from a session', async () => {
    const { cookie: sessionCookie } = viewer
    const response = await app.inject({
      method: 'POST', url: '/api/v1/public/subscriptions', headers: { cookie: sessionCookie! },
      payload: { type: 'email', email: 'x@example.test' },
    })
    assert.equal(response.statusCode, 403)
  })

  it('makes a user with a temporary password replace it first', async () => {
    const fresh = await signIn('fresh@example.test')
    assert.equal((await app.inject({ url: '/api/v1/public/access', headers: fresh })).json().passwordChangeRequired, true)
    const status = await app.inject({ url: '/api/v1/public/status', headers: fresh })
    assert.equal(status.statusCode, 403)
    assert.equal(status.json().code, 'PASSWORD_CHANGE_REQUIRED')
  })

  it('opens again once it is made public', async () => {
    assert.equal((await setAccess({ private: false })).statusCode, 200)
    assert.equal((await app.inject({ url: '/api/v1/public/status' })).statusCode, 200)
    assert.equal((await app.inject({ url: '/api/v1/public/incidents.rss' })).statusCode, 200)
  })
})

describe('Viewer accounts', () => {
  it('can be created directly with any valid role', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: admin, payload: { email: 'new-viewer@example.test', role: 'viewer' } })
    assert.equal(created.statusCode, 200)
    assert.equal(created.json().role, 'viewer')
    const defaulted = await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: admin, payload: { email: 'designer@example.test' } })
    assert.equal(defaulted.json().role, 'branding')
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: admin, payload: { email: 'x@example.test', role: 'owner' } })
    assert.equal(invalid.statusCode, 400)
  })

  it('cannot use the admin console API', async () => {
    assert.equal((await app.inject({ url: '/api/v1/admin/subscribers/settings', headers: viewer })).statusCode, 403)
    assert.equal((await app.inject({ url: '/api/v1/admin/users', headers: viewer })).statusCode, 403)
  })
})
