import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { monitors } from '../src/db/schema.js'
import { layoutRoutes } from '../src/routes/layout.js'
import { monitorRoutes } from '../src/routes/monitors.js'
import { notificationRoutes } from '../src/routes/notifications.js'
import { SECRET_MASK } from '../src/services/secretFields.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-secret-redirect-')
const app = Fastify({ logger: false })

before(async () => {
  initTestDb()
  app.addHook('preHandler', async (request) => {
    request.user = { userId: 1, email: 'admin@example.test', role: 'admin' }
  })
  await app.register(monitorRoutes, { prefix: '/monitors' })
  await app.register(notificationRoutes, { prefix: '/notifications' })
  await app.register(layoutRoutes, { prefix: '/layout' })
  await app.ready()
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

const httpsBody = (name: string) => ({
  name, type: 'https',
  config: { url: 'https://example.test', method: 'GET', expectedStatus: 200, headers: { Authorization: 'Bearer abc' }, auth: { type: 'basic', basic: { username: 'svc', password: 'p4ss' } } },
})
const storedConfig = async (id: number) => JSON.parse((await db.select().from(monitors).where(eq(monitors.id, id)))[0]!.config)

describe('secrets cannot be read or redirected through an edit', () => {
  const patch = (id: number, payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/monitors/${id}`, payload })
  const create = async (name: string) => (await app.inject({ method: 'POST', url: '/monitors', payload: httpsBody(name) })).json()

  it('refuses a type change without a config, so the old secret cannot slip out unmasked', async () => {
    const created = await create('Retype only')
    const response = await patch(created.id, { type: 'ping' })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error, 'Changing the type needs a new config in the same request')
    assert.equal((await storedConfig(created.id)).auth.basic.password, 'p4ss')
    assert.equal((await app.inject({ url: `/monitors/${created.id}` })).json().type, 'https')
    assert.equal((await patch(created.id, { type: 'ping', config: { host: 'h', mode: 'tcp', port: 22 } })).statusCode, 200)
  })

  it('masks a leftover secret even when the stored type no longer has that field', async () => {
    const now = Date.now()
    const [row] = await db.insert(monitors).values({
      name: 'Legacy', type: 'ping', config: JSON.stringify({ host: 'h', mode: 'tcp', auth: { basic: { password: 'p4ss' } } }), createdAt: now, updatedAt: now,
    }).returning()
    const shown = (await app.inject({ url: `/monitors/${row!.id}` })).json()
    assert.equal(shown.config.auth.basic.password, SECRET_MASK)
    assert.equal(JSON.stringify((await app.inject({ url: '/monitors' })).json()).includes('p4ss'), false)
  })

  it('refuses to keep a stored secret while the monitor is pointed somewhere else', async () => {
    const created = await create('Redirect')
    const redirected = structuredClone(created.config)
    redirected.url = 'https://attacker.test'
    const refused = await patch(created.id, { config: redirected })
    assert.equal(refused.statusCode, 400)
    assert.match(refused.json().error, /^url changed, so the stored secrets cannot be kept/)
    assert.equal((await storedConfig(created.id)).url, 'https://example.test')

    redirected.auth.basic.password = 'entered-again'
    redirected.headers.Authorization = 'Bearer again'
    assert.equal((await patch(created.id, { config: redirected })).statusCode, 200)
    const moved = await storedConfig(created.id)
    assert.deepEqual([moved.url, moved.auth.basic.password, moved.headers.Authorization], ['https://attacker.test', 'entered-again', 'Bearer again'])
  })

  it('applies the same rule to a test run, which would use the stored secret right away', async () => {
    const created = await create('Test redirect')
    const redirected = structuredClone(created.config)
    redirected.url = 'https://attacker.test'
    const refused = await app.inject({ method: 'POST', url: '/monitors/test', payload: { type: 'https', monitorId: created.id, config: redirected } })
    assert.equal(refused.statusCode, 400)
    assert.match(refused.json().error, /changed, so the stored secrets cannot be kept/)
  })

  it('refuses a half-deleted mask and a secret that is not text', async () => {
    const created = await create('Edited mask')
    const edited = structuredClone(created.config)
    edited.auth.basic.password = '•••••••'
    assert.equal((await patch(created.id, { config: edited })).statusCode, 400)
    edited.auth.basic.password = 123456
    assert.equal((await patch(created.id, { config: edited })).json().error, 'auth.basic.password must be text')
    assert.equal((await storedConfig(created.id)).auth.basic.password, 'p4ss')
  })
})

describe('notification channel input', () => {
  const channel = { name: 'Hook', type: 'slack', config: { webhookUrl: 'https://hooks.test/a' } }
  const create = async (payload: Record<string, unknown> = channel) => (await app.inject({ method: 'POST', url: '/notifications/channels', payload })).json()
  const patch = (id: number, payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/notifications/channels/${id}`, payload })

  it('refuses a type change without a config, and unknown types', async () => {
    const created = await create()
    const retyped = await patch(created.id, { type: 'webhook' })
    assert.equal(retyped.statusCode, 400)
    assert.equal(retyped.json().error, 'Changing the type needs a new config in the same request')
    assert.match((await patch(created.id, { type: 'bogus', config: {} })).json().error, /^Type must be one of/)
    const shown = (await app.inject({ url: `/notifications/channels/${created.id}` })).json()
    assert.deepEqual([shown.type, shown.config.webhookUrl], ['slack', SECRET_MASK])
  })

  it('needs the config to be an object', async () => {
    for (const config of ['https://hooks.test/a', ['x'], 5]) {
      const response = await app.inject({ method: 'POST', url: '/notifications/channels', payload: { ...channel, config } })
      assert.equal(response.json().error, 'config must be an object')
    }
    const created = await create()
    assert.equal((await patch(created.id, { config: [] })).json().error, 'config must be an object')
  })

  it('refuses to keep webhook header credentials while the URL changes', async () => {
    const created = await create({ name: 'Hdr', type: 'webhook', config: { url: 'https://hooks.test/a', method: 'POST', headers: { Authorization: 'Bearer abc' } } })
    const moved = structuredClone(created.config)
    moved.url = 'https://attacker.test'
    const refused = await patch(created.id, { config: moved })
    assert.equal(refused.statusCode, 400)
    assert.match(refused.json().error, /^url changed/)
    moved.headers.Authorization = 'Bearer again'
    assert.equal((await patch(created.id, { config: moved })).statusCode, 200)
  })
})

describe('layout input', () => {
  it('refuses a body without a tree instead of failing', async () => {
    for (const payload of [{}, { tree: null }, { tree: 'page' }, { tree: [] }]) {
      const response = await app.inject({ method: 'PUT', url: '/layout', payload })
      assert.equal(response.statusCode, 400, JSON.stringify(payload))
      assert.equal(response.json().error, 'tree must be an object')
    }
    const tree = { id: 'root', type: 'page', children: [] }
    assert.deepEqual((await app.inject({ method: 'PUT', url: '/layout', payload: { tree } })).json(), tree)
  })
})
