import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { PUBLIC_EVENTS_RATE_LIMIT } from '../src/config/rateLimits.js'
import { publicRoutes } from '../src/routes/public.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-public-events-rate-limit-test-')
const app = Fastify({ logger: false })
const limits = new Map<string, unknown>()

before(async () => {
  initTestDb()
  app.addHook('onRoute', (route) => { limits.set(route.url, (route.config as { rateLimit?: unknown } | undefined)?.rateLimit) })
  await app.register(rateLimit, { global: false })
  await app.register(publicRoutes, { prefix: '/public' })
  await app.ready()
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

describe('public event stream', () => {
  it('is rate limited, because every open holds a connection', () => {
    assert.deepEqual(limits.get('/public/events'), PUBLIC_EVENTS_RATE_LIMIT)
  })
})
