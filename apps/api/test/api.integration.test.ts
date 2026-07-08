import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { eq } from 'drizzle-orm'
import { db, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { layout, monitorResults, monitors } from '../src/db/schema.js'
import { publicRoutes } from '../src/routes/public.js'
import { webhookRoutes } from '../src/routes/webhook.js'

const dataDir = mkdtempSync(join(tmpdir(), 'bsp-api-test-'))
process.env['DATABASE_PATH'] = join(dataDir, 'test.sqlite')

const app = Fastify({ logger: false })
let monitorId = 0
const webhookToken = 'ab'.repeat(24)

before(async () => {
  initDb()
  runMigrations()

  const now = Date.now()
  const inserted = await db.insert(monitors).values({
    name: 'Webhook monitor',
    type: 'webhook',
    intervalSecs: 60,
    timeoutMs: 1_000,
    retries: 1,
    config: '{}',
    currentStatus: 'down',
    webhookToken,
    tags: '[]',
    createdAt: now,
    updatedAt: now,
  }).returning()
  monitorId = inserted[0]!.id

  await db.insert(monitorResults).values([
    { monitorId, status: 'up', responseMs: 25, checkedAt: now - 2_000, errorMessage: null },
    { monitorId, status: 'down', responseMs: null, checkedAt: now - 1_000, errorMessage: 'timeout' },
  ])
  await db.insert(layout).values({
    id: 1,
    tree: JSON.stringify({
      id: 'root',
      type: 'page',
      children: [
        { id: 'valid', type: 'monitor', monitorId, showUptimeBar: true },
        { id: 'orphan', type: 'monitor', monitorId: 999_999, showUptimeBar: true },
      ],
    }),
    updatedAt: now,
  })

  await app.register(rateLimit, { global: false })
  await app.register(publicRoutes, { prefix: '/api/v1/public' })
  await app.register(webhookRoutes, { prefix: '/api/v1/hook' })
  await app.ready()
})

after(async () => {
  await app.close()
  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('public API integration', () => {
  it('returns public monitor state without private config', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/public/status' })
    assert.equal(response.statusCode, 200)

    const payload = response.json()
    assert.equal(payload.monitors.length, 1)
    assert.equal(payload.monitors[0].id, monitorId)
    assert.equal('config' in payload.monitors[0], false)
    assert.equal('webhookToken' in payload.monitors[0], false)
    assert.deepEqual(payload.activeIncidents, [])
    assert.equal(response.headers['cache-control'], 'public, max-age=2, stale-while-revalidate=5')
    assert.equal(response.headers['x-ratelimit-limit'], undefined)

    await db.update(monitors).set({ currentStatus: 'up' }).where(eq(monitors.id, monitorId))
    const cached = await app.inject({ method: 'GET', url: '/api/v1/public/status' })
    assert.equal(cached.json().monitors[0].currentStatus, 'down')
    await db.update(monitors).set({ currentStatus: 'down' }).where(eq(monitors.id, monitorId))
  })

  it('removes references to monitors that no longer exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/public/layout' })
    assert.equal(response.statusCode, 200)

    const payload = response.json()
    assert.deepEqual(payload.tree.children.map((node: { id: string }) => node.id), ['valid'])
  })

  it('aggregates monitor uptime and response history', async () => {
    const uptime = await app.inject({
      method: 'GET',
      url: `/api/v1/public/monitor/${monitorId}/uptime?days=1`,
    })
    assert.equal(uptime.statusCode, 200)
    assert.equal(uptime.headers['x-ratelimit-limit'], '300')
    assert.equal(uptime.json().days[0].checksTotal, 2)
    assert.equal(uptime.json().overallUptimePct, 50)

    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/public/monitor/${monitorId}/history?hours=1&buckets=10`,
    })
    assert.equal(history.statusCode, 200)
    assert.equal(history.json().buckets.length, 10)
    assert.equal(history.json().buckets.reduce((sum: number, bucket: { count: number }) => sum + bucket.count, 0), 2)

    const invalidBounds = await app.inject({
      method: 'GET', url: `/api/v1/public/monitor/${monitorId}/history?hours=999&buckets=1`,
    })
    assert.equal(invalidBounds.statusCode, 400)
    assert.equal((await app.inject({
      method: 'GET', url: `/api/v1/public/monitor/${monitorId}/uptime?days=999999`,
    })).statusCode, 400)
    assert.equal((await app.inject({
      method: 'GET', url: '/api/v1/public/incidents?page=0&limit=1000',
    })).statusCode, 400)
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/public/monitor/999999/history' })).statusCode, 404)
  })

  it('accepts a valid heartbeat and rejects an invalid token', async () => {
    const missing = await app.inject({ method: 'POST', url: '/api/v1/hook/missing' })
    assert.equal(missing.statusCode, 404)

    const heartbeat = await app.inject({ method: 'POST', url: `/api/v1/hook/${webhookToken}` })
    assert.equal(heartbeat.statusCode, 200)
    assert.deepEqual(heartbeat.json(), { ok: true })

    const monitor = (await db.select().from(monitors).where(eq(monitors.id, monitorId)))[0]!
    assert.equal(monitor.currentStatus, 'up')

    const results = await db.select().from(monitorResults).where(eq(monitorResults.monitorId, monitorId))
    assert.equal(results.length, 3)
    assert.equal(results.at(-1)?.status, 'up')
  })
})
