import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { monitorRoutes } from '../src/routes/monitors.js'
import { notificationRoutes } from '../src/routes/notifications.js'
import { isValidEntityKey, slugifyKey } from '../src/lib/entityKey.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-entity-key-')
const app = Fastify({ logger: false })

before(async () => {
  initTestDb()
  app.addHook('preHandler', async (request) => {
    request.user = { userId: 1, email: 'admin@example.test', role: 'admin' }
  })
  await app.register(monitorRoutes, { prefix: '/monitors' })
  await app.register(notificationRoutes, { prefix: '/notifications' })
  await app.ready()
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

describe('key helpers', () => {
  it('slugifies names, dropping diacritics and punctuation', () => {
    assert.equal(slugifyKey('Główna strona (PROD)'), 'glowna-strona-prod')
    assert.equal(slugifyKey('   '), 'item')
    assert.equal(slugifyKey('!!!'), 'item')
  })

  it('only accepts lowercase config-safe keys', () => {
    assert.equal(isValidEntityKey('api-prod_1'), true)
    for (const bad of ['', 'Api', '-api', 'a b', 'a'.repeat(65), 7, null]) assert.equal(isValidEntityKey(bad), false)
  })
})

const createMonitor = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/monitors', payload: { type: 'webhook', config: {}, ...payload } })
const createChannel = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/notifications/channels', payload: { type: 'webhook', config: { url: 'https://example.test/h' }, ...payload } })

describe('monitor key', () => {
  it('derives a unique key from the name when none is given', async () => {
    const first = (await createMonitor({ name: 'Public API' })).json()
    const second = (await createMonitor({ name: 'Public API' })).json()
    assert.equal(first.key, 'public-api')
    assert.equal(second.key, 'public-api-2')
  })

  it('accepts an explicit key, rejects invalid and duplicate ones', async () => {
    const created = await createMonitor({ name: 'Billing', key: 'billing-prod' })
    assert.equal(created.json().key, 'billing-prod')
    assert.equal((await createMonitor({ name: 'Other', key: 'Bad Key' })).statusCode, 400)
    assert.equal((await createMonitor({ name: 'Other', key: 'billing-prod' })).statusCode, 409)
  })

  it('renames the key and keeps it when only the name changes', async () => {
    const monitor = (await createMonitor({ name: 'Search', key: 'search' })).json()
    const renamed = await app.inject({ method: 'PATCH', url: `/monitors/${monitor.id}`, payload: { name: 'Search v2' } })
    assert.equal(renamed.json().key, 'search')
    const rekeyed = await app.inject({ method: 'PATCH', url: `/monitors/${monitor.id}`, payload: { key: 'search-v2' } })
    assert.equal(rekeyed.json().key, 'search-v2')
    const same = await app.inject({ method: 'PATCH', url: `/monitors/${monitor.id}`, payload: { key: 'search-v2' } })
    assert.equal(same.statusCode, 200)
    const clash = await app.inject({ method: 'PATCH', url: `/monitors/${monitor.id}`, payload: { key: 'billing-prod' } })
    assert.equal(clash.statusCode, 409)
  })
})

describe('channel key', () => {
  it('derives, validates and updates the key like monitors do', async () => {
    const created = (await createChannel({ name: 'On-call Slack' })).json()
    assert.equal(created.key, 'on-call-slack')
    assert.equal((await createChannel({ name: 'Dup', key: 'on-call-slack' })).statusCode, 409)
    assert.equal((await createChannel({ name: 'Dup', key: 'NOPE' })).statusCode, 400)
    const rekeyed = await app.inject({ method: 'PATCH', url: `/notifications/channels/${created.id}`, payload: { key: 'oncall' } })
    assert.equal(rekeyed.json().key, 'oncall')
  })

  it('keeps key namespaces separate between monitors and channels', async () => {
    assert.equal((await createMonitor({ name: 'Shared', key: 'shared' })).statusCode, 200)
    assert.equal((await createChannel({ name: 'Shared', key: 'shared' })).statusCode, 200)
  })
})
