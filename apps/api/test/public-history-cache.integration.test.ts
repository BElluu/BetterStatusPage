import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { db } from '../src/db/client.js'
import { eq } from 'drizzle-orm'
import { layout, monitorResults, monitors } from '../src/db/schema.js'
import { refreshPublishedMonitorIds } from '../src/services/publishedMonitors.js'
import { publicRoutes } from '../src/routes/public.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-public-history-cache-test-')
const app = Fastify({ logger: false })
let published = 0
let hidden = 0

before(async () => {
  initTestDb()
  const now = Date.now()
  const base = { type: 'https', config: '{}', createdAt: now, updatedAt: now }
  published = (await db.insert(monitors).values({ ...base, name: 'Shown' }).returning())[0]!.id
  hidden = (await db.insert(monitors).values({ ...base, name: 'Internal' }).returning())[0]!.id
  await db.insert(layout).values({ id: 1, tree: JSON.stringify({ id: 'root', type: 'page', children: [24, 12, 6].flatMap((hours) => [30, 40].map((buckets) => ({ id: `c${hours}-${buckets}`, type: 'chart', monitorId: published, hours, buckets, aggregation: 'avg' }))) }), updatedAt: now })
  await app.register(rateLimit, { global: false })
  await app.register(publicRoutes, { prefix: '/public' })
  await app.ready()
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

const addResult = (monitorId: number) =>
  db.insert(monitorResults).values({ monitorId, status: 'up', responseMs: 10, checkedAt: Date.now() - 1000 })
const checks = async (query: string, id = published) => {
  const response = await app.inject({ url: `/public/monitor/${id}/history?${query}` })
  assert.equal(response.statusCode, 200)
  return (response.json() as { buckets: Array<{ count: number }> }).buckets.reduce((sum, bucket) => sum + bucket.count, 0)
}

describe('public history cache', () => {
  it('serves the short-lived cached copy of the same request, and only of the same request', async () => {
    await addResult(published)
    assert.equal(await checks('hours=24&buckets=30'), 1)

    await addResult(published)
    assert.equal(await checks('hours=24&buckets=30'), 1, 'the same request is answered from the copy')
    assert.equal(await checks('hours=24&buckets=40'), 2, 'another number of buckets is another request')
    assert.equal(await checks('hours=12&buckets=30'), 2, 'so is another window')
  })

  it('stops serving a monitor taken off the page, though its chart is still cached', async () => {
    assert.equal(await checks('hours=6&buckets=30'), 2) // now cached
    await db.update(layout).set({ tree: JSON.stringify({ id: 'root', type: 'page', children: [] }) }).where(eq(layout.id, 1))
    await refreshPublishedMonitorIds() // what saving the layout does
    assert.equal((await app.inject({ url: `/public/monitor/${published}/history?hours=6&buckets=30` })).statusCode, 404)
  })

  it('still refuses a monitor that is not on the page, and a bad request', async () => {
    await addResult(hidden)
    assert.equal((await app.inject({ url: `/public/monitor/${hidden}/history?hours=24&buckets=30` })).statusCode, 404)
    assert.equal((await app.inject({ url: `/public/monitor/${published}/history?hours=0` })).statusCode, 400)
  })
})
