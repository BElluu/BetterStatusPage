import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { layout, monitorDependencies, monitorResults, monitors } from '../src/db/schema.js'
import { publicRoutes } from '../src/routes/public.js'
import { webhookRoutes } from '../src/routes/webhook.js'
import { refreshPublishedMonitorIds } from '../src/services/publishedMonitors.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-api-test-')

const app = Fastify({ logger: false })
let monitorId = 0
const webhookToken = 'ab'.repeat(24)

before(async () => {
  initTestDb()

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
        { id: 'chart-1h', type: 'chart', monitorId, hours: 1, buckets: 10, aggregation: 'avg' },
        { id: 'chart-90d', type: 'chart', monitorId, hours: 2160, buckets: 30, aggregation: 'avg' },
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
  teardownTestDb(testDb)
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
    assert.deepEqual(payload.tree.children.map((node: { id: string }) => node.id), ['valid', 'chart-1h', 'chart-90d'])
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
    // A valid range that no chart of the page asks for is not computed.
    assert.equal((await app.inject({
      method: 'GET', url: `/api/v1/public/monitor/${monitorId}/history?hours=1&buckets=11`,
    })).statusCode, 404)
    assert.equal((await app.inject({
      method: 'GET', url: `/api/v1/public/monitor/${monitorId}/history?hours=2160&buckets=30`,
    })).statusCode, 200)
    assert.equal((await app.inject({
      method: 'GET', url: `/api/v1/public/monitor/${monitorId}/history?hours=2161&buckets=30`,
    })).statusCode, 400)
    assert.equal((await app.inject({
      method: 'GET', url: `/api/v1/public/monitor/${monitorId}/uptime?days=999999`,
    })).statusCode, 400)
    assert.equal((await app.inject({
      method: 'GET', url: '/api/v1/public/incidents?page=0&limit=1000',
    })).statusCode, 400)
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/public/monitor/999999/history' })).statusCode, 404)
  })

  it('reports no overall uptime when a monitor has no results', async () => {
    const now = Date.now()
    const inserted = await db.insert(monitors).values({
      name: 'New monitor',
      type: 'webhook',
      intervalSecs: 60,
      timeoutMs: 1_000,
      retries: 1,
      config: '{}',
      currentStatus: 'pending',
      webhookToken: 'cd'.repeat(24),
      tags: '[]',
      createdAt: now,
      updatedAt: now,
    }).returning()
    const unpublished = await app.inject({ method: 'GET', url: `/api/v1/public/monitor/${inserted[0]!.id}/uptime?days=30` })
    assert.equal(unpublished.statusCode, 404)

    await db.update(layout).set({
      tree: JSON.stringify({ id: 'root', type: 'page', children: [
        { id: 'valid', type: 'monitor', monitorId, showUptimeBar: true },
        { id: 'new', type: 'monitor', monitorId: inserted[0]!.id, showUptimeBar: true },
      ] }),
    })
    await refreshPublishedMonitorIds()

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/public/monitor/${inserted[0]!.id}/uptime?days=30`,
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().overallUptimePct, null)
    assert.ok(response.json().days.every((day: { status: string }) => day.status === 'no-data'))
    assert.equal((await app.inject({
      method: 'GET',
      url: '/api/v1/public/monitor/999999/uptime',
    })).statusCode, 404)
  })

  it('shows a day spent in maintenance as maintenance and notes maintenance on a mixed day', async () => {
    const now = Date.now()
    const [monitor] = await db.insert(monitors).values({
      name: 'Nightly job', type: 'webhook', intervalSecs: 60, timeoutMs: 1_000, retries: 1, config: '{}', currentStatus: 'up',
      webhookToken: 'ef'.repeat(24), tags: '[]', createdAt: now, updatedAt: now,
    }).returning()
    const id = monitor!.id
    const midday = (daysAgo: number) => Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() - daysAgo, 12)
    await db.insert(monitorResults).values([
      // Two days ago: every check failed inside a maintenance window.
      { monitorId: id, status: 'down', responseMs: null, checkedAt: midday(2), errorMessage: 'boom', unconfirmed: 2 },
      // Yesterday: one good check and one failure inside a window.
      { monitorId: id, status: 'up', responseMs: 20, checkedAt: midday(1), errorMessage: null },
      { monitorId: id, status: 'down', responseMs: null, checkedAt: midday(1) + 60_000, errorMessage: 'boom', unconfirmed: 2 },
    ])
    const current = (await db.select().from(layout))[0]!
    const tree = JSON.parse(current.tree) as { children: unknown[] }
    await db.update(layout).set({ tree: JSON.stringify({ ...tree, children: [...tree.children, { id: 'nightly', type: 'monitor', monitorId: id, showUptimeBar: true }] }) })
    await refreshPublishedMonitorIds()

    const days = (await app.inject({ method: 'GET', url: `/api/v1/public/monitor/${id}/uptime?days=3` })).json().days as Array<{
      status: string; uptimePct: number; checksTotal: number; maintenanceChecks: number
    }>
    assert.equal(days[0]!.status, 'maintenance')
    assert.equal(days[0]!.checksTotal, 0)
    assert.equal(days[0]!.maintenanceChecks, 1)
    assert.equal(days[1]!.status, 'up')
    assert.equal(days[1]!.uptimePct, 100)
    assert.equal(days[1]!.maintenanceChecks, 1)
    assert.equal(days[2]!.status, 'no-data')
  })

  it('leaves failures inside maintenance out of the response time chart status', async () => {
    const now = Date.now()
    const [monitor] = await db.insert(monitors).values({
      name: 'Chart job', type: 'webhook', intervalSecs: 60, timeoutMs: 1_000, retries: 1, config: '{}', currentStatus: 'up',
      webhookToken: 'ab'.repeat(24), tags: '[]', createdAt: now, updatedAt: now,
    }).returning()
    const id = monitor!.id
    await db.insert(monitorResults).values([
      { monitorId: id, status: 'down', responseMs: null, checkedAt: now - 3 * 3_600_000, errorMessage: 'boom', unconfirmed: 2 },
      { monitorId: id, status: 'down', responseMs: null, checkedAt: now - 2 * 3_600_000, errorMessage: 'boom', unconfirmed: 2 },
      { monitorId: id, status: 'down', responseMs: null, checkedAt: now - 3_600_000 / 2, errorMessage: 'boom', unconfirmed: 0 },
    ])
    const current = (await db.select().from(layout))[0]!
    const tree = JSON.parse(current.tree) as { children: unknown[] }
    await db.update(layout).set({ tree: JSON.stringify({ ...tree, children: [...tree.children, { id: 'chart', type: 'chart', monitorId: id, hours: 4, buckets: 10, aggregation: 'avg' }] }) })
    await refreshPublishedMonitorIds()

    const { buckets } = (await app.inject({ method: 'GET', url: `/api/v1/public/monitor/${id}/history?hours=4&buckets=10` })).json() as {
      buckets: Array<{ count: number; status: string | null }>
    }
    const statuses = buckets.filter((b) => b.count > 0).map((b) => b.status)
    assert.deepEqual(statuses, ['maintenance', 'maintenance', 'down'])
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

  it('records a reported failure with its message and rejects an unknown status', async () => {
    const bad = await app.inject({ method: 'GET', url: `/api/v1/hook/${webhookToken}?status=broken` })
    assert.equal(bad.statusCode, 400)

    const down = await app.inject({ method: 'GET', url: `/api/v1/hook/${webhookToken}?status=down&msg=backup%20failed` })
    assert.equal(down.statusCode, 200)
    let last = (await db.select().from(monitorResults).where(eq(monitorResults.monitorId, monitorId))).at(-1)!
    assert.equal(last.status, 'down')
    assert.equal(last.errorMessage, 'backup failed')

    await app.inject({ method: 'GET', url: `/api/v1/hook/${webhookToken}?status=degraded&msg=${'x'.repeat(600)}` })
    last = (await db.select().from(monitorResults).where(eq(monitorResults.monitorId, monitorId))).at(-1)!
    assert.equal(last.status, 'degraded')
    assert.equal(last.errorMessage?.length, 500)

    await app.inject({ method: 'GET', url: `/api/v1/hook/${webhookToken}?msg=ignored` })
    last = (await db.select().from(monitorResults).where(eq(monitorResults.monitorId, monitorId))).at(-1)!
    assert.equal(last.status, 'up')
    assert.equal(last.errorMessage, null)
  })

  it('cleans the message and handles odd query forms', async () => {
    const lastResult = async () => (await db.select().from(monitorResults).where(eq(monitorResults.monitorId, monitorId))).at(-1)!
    const hook = (query: string) => app.inject({ method: 'GET', url: `/api/v1/hook/${webhookToken}${query}` })

    assert.equal((await hook('?status=down&status=up')).statusCode, 400)
    assert.equal((await hook('?status=UP')).statusCode, 400)
    assert.equal((await hook('?status=down&msg=a&msg=b')).statusCode, 400)

    // An empty status is a plain heartbeat.
    assert.equal((await hook('?status=')).statusCode, 200)
    assert.equal((await lastResult()).status, 'up')

    // Control, bidi and zero-width characters are replaced, a blank message is dropped.
    await hook(`?status=down&msg=${encodeURIComponent('a\r\nb\u202Ec\u200Bd\u0000e')}`)
    assert.equal((await lastResult()).errorMessage, 'a  b c d e')
    await hook(`?status=down&msg=${encodeURIComponent('  \n ')}`)
    assert.equal((await lastResult()).errorMessage, null)

    // Invisible tag characters and the Arabic letter mark are replaced too.
    await hook(`?status=down&msg=${encodeURIComponent('ok' + String.fromCodePoint(0xe0041, 0x61c) + 'go')}`)
    assert.equal((await lastResult()).errorMessage, 'ok  go')

    // The cut never splits a surrogate pair.
    await hook(`?status=down&msg=${encodeURIComponent('\u{1F600}'.repeat(600))}`)
    assert.equal(Array.from((await lastResult()).errorMessage!).length, 500)
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test((await lastResult()).errorMessage!))
  })

  it('marks a failing heartbeat affected when a dependency is down', async () => {
    const now = Date.now()
    const dependency = (await db.insert(monitors).values({
      name: 'Dependency', type: 'https', intervalSecs: 60, timeoutMs: 1_000, retries: 1, config: '{}',
      currentStatus: 'down', tags: '[]', createdAt: now, updatedAt: now,
    }).returning())[0]!
    await db.insert(monitorDependencies).values({ dependentId: monitorId, dependsOnId: dependency.id })

    await app.inject({ method: 'GET', url: `/api/v1/hook/${webhookToken}?status=down&msg=failed` })
    let last = (await db.select().from(monitorResults).where(eq(monitorResults.monitorId, monitorId))).at(-1)!
    assert.equal(last.status, 'affected')

    await app.inject({ method: 'GET', url: `/api/v1/hook/${webhookToken}?status=degraded` })
    last = (await db.select().from(monitorResults).where(eq(monitorResults.monitorId, monitorId))).at(-1)!
    assert.equal(last.status, 'affected')

    // A healthy heartbeat stays up.
    await app.inject({ method: 'GET', url: `/api/v1/hook/${webhookToken}` })
    last = (await db.select().from(monitorResults).where(eq(monitorResults.monitorId, monitorId))).at(-1)!
    assert.equal(last.status, 'up')
  })
})
