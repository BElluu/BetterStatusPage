import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import jwt from '@fastify/jwt'
import { requireAuth, requireRole } from '../src/middleware/auth.js'
import { authSessions, users } from '../src/db/schema.js'
import { db } from '../src/db/client.js'
import { monitorRoutes } from '../src/routes/monitors.js'
import { revokeSession, revokeUserSessions } from '../src/services/authSession.js'
import { serveEventStream, sseService } from '../src/services/sse.service.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-admin-events-')

const app = Fastify({ logger: false })
const tokens: Record<string, string> = {}
const userIds: Record<string, number> = {}
let baseUrl = ''
let allowed = true

before(async () => {
  initTestDb()
  await app.register(jwt, { secret: 'test-secret-with-sufficient-entropy' })
  await app.register(cookie)
  // Same guard chain as the production admin API in src/index.ts.
  await app.register(async (adminApp) => {
    adminApp.addHook('preHandler', requireAuth)
    await adminApp.register(async (sub) => {
      sub.addHook('preHandler', requireRole('operator'))
      await sub.register(monitorRoutes, { prefix: '/monitors' })
    })
  }, { prefix: '/api/v1/admin' })
  app.get('/revalidated', (req, reply) => serveEventStream(req, reply, { stillAllowed: async () => allowed, pingIntervalMs: 20 }))

  const now = Date.now()
  for (const name of ['operator', 'operator-2nd-tab', 'branding']) {
    const role = name.startsWith('operator') ? 'operator' : 'branding'
    const email = `${role}@example.test`
    let userId = (await db.select().from(users)).find((user) => user.email === email)?.id
    if (!userId) userId = (await db.insert(users).values({ email, passwordHash: 'unused', role, createdAt: now }).returning())[0]!.id
    await db.insert(authSessions).values({ id: `session-${name}`, userId, csrfTokenHash: 'unused', createdAt: now, lastSeenAt: now, expiresAt: now + 3_600_000 })
    tokens[name] = app.jwt.sign({ userId, email, role, sessionId: `session-${name}` })
    userIds[name] = userId
  }
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' })
})

after(async () => {
  sseService.closeAll()
  await app.close()
  teardownTestDb(testDb)
})

/** Opens a stream and returns helpers to read it until a marker or until the server ends it. */
async function open(path: string, token?: string) {
  const response = await fetch(`${baseUrl}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {})
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  return {
    status: response.status,
    get text() { return text },
    async readUntil(marker: string) {
      while (!text.includes(marker)) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`stream ended before ${marker}`)
        text += decoder.decode(value)
      }
    },
    async ended(): Promise<boolean> {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return true
        text += decoder.decode(value)
      }
    },
    cancel: () => reader.cancel(),
  }
}

describe('admin monitor event stream', () => {
  it('is only open to operators and admins', async () => {
    assert.equal((await app.inject({ url: '/api/v1/admin/monitors/events' })).statusCode, 401)
    const branding = await app.inject({ url: '/api/v1/admin/monitors/events', headers: { authorization: `Bearer ${tokens['branding']}` } })
    assert.equal(branding.statusCode, 403)
  })

  it('carries every monitor, and ends as soon as the session is revoked', async () => {
    const stream = await open('/api/v1/admin/monitors/events', tokens['operator'])
    const otherTab = await open('/api/v1/admin/monitors/events', tokens['operator-2nd-tab'])
    assert.equal(stream.status, 200)
    await stream.readUntil('event: ping')
    await otherTab.readUntil('event: ping')

    // No layout exists, so this monitor is internal — admins still see it.
    sseService.broadcast('monitor.status', { monitorId: 4242, status: 'down' })
    await stream.readUntil('"monitorId":4242')

    // Signing out one session closes only that stream.
    await revokeSession('session-operator')
    assert.equal(await stream.ended(), true)
    sseService.broadcast('monitor.status', { monitorId: 4343, status: 'up' })
    await otherTab.readUntil('"monitorId":4343')

    // A role change or deleted account revokes every session of the user.
    await revokeUserSessions(userIds['operator-2nd-tab']!)
    assert.equal(await otherTab.ended(), true)
  })

  it('ends a stream whose access no longer holds at the next keep-alive', async () => {
    allowed = true
    const stream = await open('/revalidated')
    await stream.readUntil('"ts"')
    allowed = false
    assert.equal(await stream.ended(), true)
  })
})
