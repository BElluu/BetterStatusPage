import assert from 'node:assert/strict'

process.env['UPDATE_CHECK'] = 'false'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { adminApi } from '../src/adminApi.js'
import rateLimit from '@fastify/rate-limit'
import { webhookRoutes } from '../src/routes/webhook.js'
import { getDueMonitors } from '../src/workers/scheduler.js'
import { refreshPublishedMonitorIds } from '../src/services/publishedMonitors.js'
import { getHeartbeatAutoCreateLimit } from '../src/config/heartbeat.js'
import { HEARTBEAT_KEY_RATE_LIMIT } from '../src/config/rateLimits.js'
import { db } from '../src/db/client.js'
import { apiTokens, auditLog, authSessions, monitors, users } from '../src/db/schema.js'
import { auth } from '../src/kit/auth.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'
const { resetApiTokenBudgets } = auth.apiTokens

const testDb = createTestDb('bsp-heartbeat-key-')
process.env['UPLOAD_DIR'] = join(testDb.dir, 'uploads')
const app = Fastify({ logger: false })
const PASSWORD = 'admin-password'
let adminAuthorization = ''

before(async () => {
  initTestDb()
  await app.register(cookie)
  await app.register(jwt, { secret: 'test-secret-with-sufficient-entropy' })
  await app.register(multipart)
  await app.register(adminApi, { prefix: '/admin' })
  await app.register(webhookRoutes, { prefix: '/hook' })
  await app.ready()

  const now = Date.now()
  const passwordHash = await bcrypt.hash(PASSWORD, 4)
  const [user] = await db.insert(users).values({ email: 'admin@example.test', passwordHash, role: 'admin', createdAt: now }).returning()
  await db.insert(authSessions).values({ id: 'session-admin', userId: user!.id, csrfTokenHash: 'unused', createdAt: now, lastSeenAt: now, expiresAt: now + 60_000 })
  adminAuthorization = `Bearer ${app.jwt.sign({ userId: user!.id, email: user!.email, role: 'admin', sessionId: 'session-admin' })}`
})

after(async () => {
  delete process.env['HEARTBEAT_AUTO_CREATE_LIMIT']
  await app.close()
  teardownTestDb(testDb)
})

beforeEach(() => resetApiTokenBudgets())

async function createToken(...scopes: string[]) {
  const response = await app.inject({
    method: 'POST', url: '/admin/api-tokens', headers: { authorization: adminAuthorization },
    payload: { name: `sender-${Math.random()}`, scopes, currentPassword: PASSWORD },
  })
  assert.equal(response.statusCode, 200)
  return response.json() as { id: number, token: string }
}
const tokenWith = async (...scopes: string[]) => (await createToken(...scopes)).token

const ping = (key: string, token: string | null, query = '', method: 'GET' | 'POST' = 'GET') =>
  app.inject({ method, url: `/hook/key/${key}${query}`, headers: token ? { authorization: `Bearer ${token}` } : {} })
const rowOf = async (key: string) => (await db.select().from(monitors).where(eq(monitors.key, key)))[0]

describe('heartbeat by key', () => {
  it('refuses a request without a bearer token, also one that only has a session cookie', async () => {
    assert.equal((await ping('pbs_a_gc', null)).statusCode, 401)
    const cookieOnly = await app.inject({ url: '/hook/key/pbs_a_gc', cookies: { bsp_session: app.jwt.sign({ userId: 1, email: 'x', role: 'admin', sessionId: 'session-admin' }) } })
    assert.equal(cookieOnly.statusCode, 401)
    assert.equal(await rowOf('pbs_a_gc'), undefined)
  })

  it('answers 403 without monitors:write, the same for a key that exists and one that does not', async () => {
    const token = await tokenWith('monitors:read')
    await ping('existing_one', await tokenWith('monitors:write'))
    const known = await ping('existing_one', token)
    const unknown = await ping('nothing_here', token)
    assert.equal(known.statusCode, 403)
    assert.deepEqual(known.json(), unknown.json())
    assert.equal(await rowOf('nothing_here'), undefined)
  })

  it('creates a private webhook monitor on the first heartbeat and records the heartbeat', async () => {
    const token = await tokenWith('monitors:write')
    const first = await ping('pbs_store1_gc', token)
    assert.equal(first.statusCode, 201)
    assert.deepEqual(first.json(), { ok: true, created: true })

    const row = (await rowOf('pbs_store1_gc'))!
    assert.equal(row.type, 'webhook')
    assert.equal(row.name, 'pbs_store1_gc')
    assert.equal(row.currentStatus, 'up')
    assert.match(row.webhookToken ?? '', /^[0-9a-f]{48}$/)
    assert.ok(row.autoCreatedByTokenId)

    const [audit] = await db.select().from(auditLog).where(eq(auditLog.entityName, 'pbs_store1_gc'))
    assert.equal(audit?.action, 'create')
    assert.equal(audit?.entityType, 'monitor')
  })

  it('pings the same monitor afterwards, with failure status and message, on GET and POST', async () => {
    const token = await tokenWith('monitors:write')
    assert.equal((await ping('pbs_store2_sync', token)).statusCode, 201)
    const second = await ping('pbs_store2_sync', token, '?status=down&msg=sync%20failed', 'POST')
    assert.equal(second.statusCode, 200)
    assert.deepEqual(second.json(), { ok: true })
    assert.equal((await rowOf('pbs_store2_sync'))?.currentStatus, 'down')
    assert.equal((await ping('pbs_store2_sync', token, '?status=nope')).statusCode, 400)
  })

  it('does not create a monitor for a request with a bad status', async () => {
    const token = await tokenWith('monitors:write')
    assert.equal((await ping('pbs_bad_status', token, '?status=UP')).statusCode, 400)
    assert.equal(await rowOf('pbs_bad_status'), undefined)
  })

  it('normalises the key and rejects one that cannot be a key', async () => {
    const token = await tokenWith('monitors:write')
    assert.equal((await ping('PBS.Store3.Prune', token)).statusCode, 201)
    assert.ok(await rowOf('pbs-store3-prune'))
    assert.equal((await ping('x'.repeat(65), token)).statusCode, 400)
    assert.equal((await ping('%20', token)).statusCode, 400)
  })

  it('answers 409 for a key held by a monitor that is not a webhook monitor', async () => {
    const token = await tokenWith('monitors:write')
    const now = Date.now()
    await db.insert(monitors).values({ key: 'site-http', name: 'Site', type: 'https', config: '{}', currentStatus: 'up', createdAt: now, updatedAt: now })
    const response = await ping('site-http', token)
    assert.equal(response.statusCode, 409)
    assert.equal((await rowOf('site-http'))?.currentStatus, 'up')
  })

  it('creates one monitor when first heartbeats for a key arrive together', async () => {
    const token = await tokenWith('monitors:write')
    const responses = await Promise.all(Array.from({ length: 10 }, () => ping('pbs_race_gc', token)))
    assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 200, 200, 200, 200, 200, 200, 200, 200, 201])
    assert.equal((await db.select().from(monitors).where(eq(monitors.key, 'pbs_race_gc'))).length, 1)
  })

  it('stops creating at the hourly limit of the token but keeps accepting heartbeats for existing keys', async () => {
    process.env['HEARTBEAT_AUTO_CREATE_LIMIT'] = '2'
    try {
      const token = await tokenWith('monitors:write')
      assert.equal((await ping('limit_a', token)).statusCode, 201)
      assert.equal((await ping('limit_b', token)).statusCode, 201)
      const over = await ping('limit_c', token)
      assert.equal(over.statusCode, 403)
      assert.equal((over.json() as { code: string }).code, 'AUTO_CREATE_LIMIT')
      assert.equal(await rowOf('limit_c'), undefined)
      assert.equal((await ping('limit_a', token)).statusCode, 200)
      // The limit is per token.
      assert.equal((await ping('limit_c', await tokenWith('monitors:write'))).statusCode, 201)
    } finally {
      delete process.env['HEARTBEAT_AUTO_CREATE_LIMIT']
    }
  })

  it('has no limit when it is 0', async () => {
    process.env['HEARTBEAT_AUTO_CREATE_LIMIT'] = '0'
    try {
      const token = await tokenWith('monitors:write')
      for (let n = 0; n < 60; n++) assert.equal((await ping(`unlimited_${n}`, token)).statusCode, 201)
    } finally {
      delete process.env['HEARTBEAT_AUTO_CREATE_LIMIT']
    }
  })

  it('counts only the monitors a token created within the last hour', async () => {
    process.env['HEARTBEAT_AUTO_CREATE_LIMIT'] = '2'
    try {
      const token = await tokenWith('monitors:write')
      assert.equal((await ping('window_a', token)).statusCode, 201)
      assert.equal((await ping('window_b', token)).statusCode, 201)
      assert.equal((await ping('window_c', token)).statusCode, 403)
      // Two hours later the first two no longer count.
      const twoHoursAgo = Date.now() - 2 * 60 * 60_000
      for (const key of ['window_a', 'window_b']) await db.update(monitors).set({ createdAt: twoHoursAgo }).where(eq(monitors.key, key))
      assert.equal((await ping('window_c', token)).statusCode, 201)
      assert.equal((await ping('window_d', token)).statusCode, 201)
      assert.equal((await ping('window_e', token)).statusCode, 403)
    } finally {
      delete process.env['HEARTBEAT_AUTO_CREATE_LIMIT']
    }
  })


  it('leaves the secret URL of the created monitor working', async () => {
    const token = await tokenWith('monitors:write')
    await ping('pbs_secret_url', token)
    const row = (await rowOf('pbs_secret_url'))!
    assert.equal((await app.inject({ url: `/hook/${row.webhookToken}?status=degraded` })).statusCode, 200)
    assert.equal((await rowOf('pbs_secret_url'))?.currentStatus, 'degraded')
  })
})

describe('heartbeat by key: requests a sender may really make', () => {
  const post = (key: string, token: string, payload: string, contentType: string) =>
    app.inject({ method: 'POST', url: `/hook/key/${key}`, headers: { authorization: `Bearer ${token}`, 'content-type': contentType }, payload })

  it('ignores a request body of any content type, also a large one', async () => {
    const token = await tokenWith('monitors:write')
    assert.equal((await post('body_json', token, JSON.stringify({ msg: 'x'.repeat(2048) }), 'application/json')).statusCode, 201)
    assert.equal((await post('body_json', token, '{ not json', 'application/json')).statusCode, 200)
    assert.equal((await post('body_text', token, 'y'.repeat(4096), 'text/plain')).statusCode, 201)
    assert.equal((await post('body_form', token, 'a=1&b=2', 'application/x-www-form-urlencoded')).statusCode, 201)
  })

  it('does not answer a HEAD request, which would run the GET handler', async () => {
    const token = await tokenWith('monitors:write')
    const response = await app.inject({ method: 'HEAD', url: '/hook/key/head_probe', headers: { authorization: `Bearer ${token}` } })
    assert.equal(response.statusCode, 404)
    assert.equal(await rowOf('head_probe'), undefined)
  })

  it('refuses a session token sent as the bearer, a revoked token and a key starting with a separator', async () => {
    const { id, token } = await createToken('monitors:write')
    const bystander = await tokenWith('monitors:write')
    assert.equal((await ping('jwt_probe', adminAuthorization.slice('Bearer '.length))).statusCode, 401)
    assert.equal((await ping('.hidden', token)).statusCode, 400)
    await db.delete(apiTokens).where(eq(apiTokens.id, id))
    assert.equal((await ping('revoked_probe', token)).statusCode, 401)
    assert.equal(await rowOf('revoked_probe'), undefined)
    assert.equal((await ping('bystander_probe', bystander)).statusCode, 201)
  })

  it('keeps accepting heartbeats for existing keys when the limit setting is invalid', async () => {
    const token = await tokenWith('monitors:write')
    assert.equal((await ping('bad_limit', token)).statusCode, 201)
    process.env['HEARTBEAT_AUTO_CREATE_LIMIT'] = 'many'
    try {
      assert.equal((await ping('bad_limit', token)).statusCode, 200)
    } finally {
      delete process.env['HEARTBEAT_AUTO_CREATE_LIMIT']
    }
  })

  it('records the creating token in the audit entry', async () => {
    const token = await tokenWith('monitors:write')
    await ping('audited_key', token)
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.entityName, 'audited_key'))
    assert.match(audit?.diff ?? '', /tokenId/)
  })
})

describe('heartbeat by key: name and interval of the new monitor', () => {
  it('uses the name and the interval of the request that creates the monitor, up to a day', async () => {
    const token = await tokenWith('monitors:write')
    const response = await ping('weekly_job', token, `?interval=43200&name=${encodeURIComponent('Weekly report (store 1)')}`)
    assert.equal(response.statusCode, 201)
    const row = (await rowOf('weekly_job'))!
    assert.equal(row.name, 'Weekly report (store 1)')
    assert.equal(row.intervalSecs, 43_200)
  })

  it('leaves an existing monitor alone when a later heartbeat names another name or interval', async () => {
    const token = await tokenWith('monitors:write')
    await ping('kept_settings', token, '?interval=3600&name=First')
    assert.equal((await ping('kept_settings', token, '?interval=7200&name=Second')).statusCode, 200)
    const row = (await rowOf('kept_settings'))!
    assert.equal(row.name, 'First')
    assert.equal(row.intervalSecs, 3600)
  })

  it('refuses an interval outside 10 to 86400 seconds, or given twice, and creates nothing', async () => {
    const token = await tokenWith('monitors:write')
    for (const query of ['?interval=9', '?interval=86401', '?interval=abc', '?interval=1.5', '?interval=-5', '?interval=60&interval=70', '?name=a&name=b']) {
      assert.equal((await ping('bad_creation', token, query)).statusCode, 400, query)
    }
    assert.equal(await rowOf('bad_creation'), undefined)
  })

  it('cleans the name, cuts it at 200 characters and falls back to the key when nothing is left', async () => {
    const token = await tokenWith('monitors:write')
    await ping('name_clean', token, `?name=${encodeURIComponent('  A\u0000B\u202EC  ')}`)
    assert.equal((await rowOf('name_clean'))?.name, 'A B C')
    await ping('name_long', token, `?name=${'x'.repeat(300)}`)
    assert.equal((await rowOf('name_long'))?.name.length, 200)
    await ping('name_blank', token, '?name=%20%20')
    assert.equal((await rowOf('name_blank'))?.name, 'name_blank')
  })
})

describe('heartbeat by key: more requests and edge cases', () => {
  it('refuses an expired token and a scheme written in lower case', async () => {
    const { id, token } = await createToken('monitors:write')
    assert.equal((await app.inject({ url: '/hook/key/scheme_probe', headers: { authorization: `bearer ${token}` } })).statusCode, 401)
    assert.equal((await ping('expiry_before', token)).statusCode, 201)
    await db.update(apiTokens).set({ expiresAt: Date.now() - 1000 }).where(eq(apiTokens.id, id))
    assert.equal((await ping('expired_probe', token)).statusCode, 401)
    assert.equal(await rowOf('expired_probe'), undefined)
  })

  it('treats empty status, interval and name as absent', async () => {
    const token = await tokenWith('monitors:write')
    assert.equal((await ping('empty_params', token, '?status=&interval=&name=')).statusCode, 201)
    const row = (await rowOf('empty_params'))!
    assert.equal(row.name, 'empty_params')
    assert.equal(row.intervalSecs, 86_400)
    assert.equal(row.currentStatus, 'up')
  })

  it('accepts a key of 64 characters, also one that only gets there after normalising, and refuses the limits beyond', async () => {
    const token = await tokenWith('monitors:write')
    assert.equal((await ping('a'.repeat(64), token)).statusCode, 201)
    assert.equal((await ping(`${'b'.repeat(30)}%20%20%20.${'c'.repeat(30)}`, token)).statusCode, 201)
    assert.ok(await rowOf(`${'b'.repeat(30)}-${'c'.repeat(30)}`))
    for (const bad of ['_leading', '-leading', '---', '%20.%20', 'a'.repeat(65)]) {
      assert.equal((await ping(bad, token)).statusCode, 400, bad)
    }
  })

  it('creates the monitor from a failing heartbeat and records it as down', async () => {
    const token = await tokenWith('monitors:write')
    const response = await ping('born_failing', token, '?status=down&msg=first%20run%20failed')
    assert.equal(response.statusCode, 201)
    assert.equal((await rowOf('born_failing'))?.currentStatus, 'down')
  })

  it('does not leave the new monitor on the status page', async () => {
    const token = await tokenWith('monitors:write')
    await ping('not_published', token)
    const id = (await rowOf('not_published'))!.id
    assert.equal((await refreshPublishedMonitorIds()).has(id), false)
  })

  it('makes the monitor due only after the interval it was created with', async () => {
    const token = await tokenWith('monitors:write')
    await ping('due_check', token, '?interval=3600')
    const row = (await rowOf('due_check'))!
    const dueAt = (now: number) => getDueMonitors([row], now).length === 1
    assert.equal(dueAt(Date.now() + 3_500_000), false)
    assert.equal(dueAt(Date.now() + 3_700_000), true)
  })

  it('creates one monitor when first heartbeats race the admin API for the same key', async () => {
    const token = await tokenWith('monitors:write')
    const adminPost = () => app.inject({
      method: 'POST', url: '/admin/monitors', headers: { authorization: adminAuthorization },
      payload: { name: 'Raced', key: 'raced_key', type: 'webhook', config: {} },
    })
    const responses = await Promise.all([
      ...Array.from({ length: 5 }, () => ping('raced_key', token)),
      adminPost(),
      ...Array.from({ length: 5 }, () => ping('raced_key', token)),
    ])
    const codes = responses.map((r) => r.statusCode)
    assert.ok(codes.every((code) => [200, 201, 409].includes(code)), codes.join(','))
    assert.equal((await db.select().from(monitors).where(eq(monitors.key, 'raced_key'))).length, 1)
  })

  it('shows the token name as the actor of the audit entry', async () => {
    const created = await app.inject({
      method: 'POST', url: '/admin/api-tokens', headers: { authorization: adminAuthorization },
      payload: { name: 'pbs-sender', scopes: ['monitors:write'], currentPassword: PASSWORD },
    })
    await ping('actor_check', (created.json() as { token: string }).token)
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.entityName, 'actor_check'))
    assert.match(audit?.userEmail ?? '', /pbs-sender/)
  })
})

describe('HEARTBEAT_AUTO_CREATE_LIMIT', () => {
  it('reads a whole number, trims it, defaults to 50 and rejects anything else', () => {
    assert.equal(getHeartbeatAutoCreateLimit({}), 50)
    assert.equal(getHeartbeatAutoCreateLimit({ HEARTBEAT_AUTO_CREATE_LIMIT: '' }), 50)
    assert.equal(getHeartbeatAutoCreateLimit({ HEARTBEAT_AUTO_CREATE_LIMIT: ' 12 ' }), 12)
    assert.equal(getHeartbeatAutoCreateLimit({ HEARTBEAT_AUTO_CREATE_LIMIT: '0' }), 0)
    for (const bad of ['-1', '1.5', '1e2', '0x10', 'many', '1234567890']) {
      assert.throws(() => getHeartbeatAutoCreateLimit({ HEARTBEAT_AUTO_CREATE_LIMIT: bad }), /non-negative integer/, bad)
    }
  })
})

describe('rate limit of the heartbeat by key', () => {
  const limited = Fastify({ logger: false })
  before(async () => {
    await limited.register(cookie)
    await limited.register(jwt, { secret: 'test-secret-with-sufficient-entropy' })
    await limited.register(rateLimit, { global: false })
    await limited.register(webhookRoutes, { prefix: '/hook' })
    await limited.ready()
  })
  after(() => limited.close())

  it('answers 429 after 60 requests with the same credentials, whatever way the key is spelled', async () => {
    const headers = { authorization: 'Bearer bsp_not-a-real-token' }
    const spellings = ['pbs.store', 'PBS-Store', 'pbs store']
    const codes: number[] = []
    for (let n = 0; n < 61; n++) codes.push((await limited.inject({ url: `/hook/key/${spellings[n % 3]}`, headers })).statusCode)
    assert.equal(codes.slice(0, 60).every((code) => code === 401), true)
    assert.equal(codes[60], 429)
  })

  it('gives other credentials, and other keys, a bucket of their own', async () => {
    const used = { authorization: 'Bearer bsp_not-a-real-token' }
    assert.equal((await limited.inject({ url: '/hook/key/pbs-store', headers: used })).statusCode, 429)
    assert.equal((await limited.inject({ url: '/hook/key/pbs-store', headers: { authorization: 'Bearer bsp_another' } })).statusCode, 401)
    assert.equal((await limited.inject({ url: '/hook/key/other-key', headers: used })).statusCode, 401)
  })

  it('keys the limiter on a hash, never on the credential itself', () => {
    const generate = (authorization: string, key: string) =>
      HEARTBEAT_KEY_RATE_LIMIT.keyGenerator({ headers: { authorization }, params: { key } } as never)
    assert.match(generate('Bearer bsp_secret', 'a'), /^[0-9a-f]{64}$/)
    assert.equal(generate('Bearer bsp_secret', 'A.B'), generate('Bearer bsp_secret', 'a-b'))
    assert.notEqual(generate('Bearer bsp_secret', 'a'), generate('Bearer bsp_other', 'a'))
  })
})
