import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import { auditDbModule, createAudit } from '@better-kit/audit'
import { openDatabase, runMigrations, type Database } from '@better-kit/db'
import { createNotifyDbModule, createNotifyRoutes, type NotifyRoutesOptions } from '@better-kit/notify'

const module = createNotifyDbModule({ sourceIdColumn: 'source_id', sourceNameColumn: 'source_name', smtpFromName: 'Alerts', newKey: () => crypto.randomUUID() })
const { notificationDeliveries, smtpSettings } = module.tables
const NOW = 1_700_000_000_000

let store: Database<Record<string, unknown>>
let app: FastifyInstance
let hidden: readonly string[]
let removed: number[]

beforeEach(async () => {
  store = openDatabase({ path: ':memory:', schema: { ...module.tables, ...auditDbModule.tables } })
  runMigrations(store.sqlite, [module, auditDbModule], { log: () => undefined })
  hidden = []
  removed = []
  const options: NotifyRoutesOptions = {
    db: store.db,
    tables: module.tables,
    audit: createAudit({ db: store.db }),
    identity: () => ({ userId: 1, email: 'admin@example.test' }),
    minSourcesKey: 'minItems',
    wire: { sourceId: 'itemId', sourceName: 'itemName', sourcePlural: 'items' },
    defaultFromName: 'Alerts',
    hiddenEventTypes: () => hidden,
    secrets: { mask: (config) => config, restore: (incoming) => ({ config: incoming }) },
    vaultUse: { refused: 'refused', problem: () => null },
    resolveKey: async (name, requested, ownerOf) => {
      const key = typeof requested === 'string' ? requested : name.toLowerCase()
      return (await ownerOf(key)) === undefined ? { key } : { status: 409, error: `Key "${key}" is already in use` }
    },
    onChannelDeleted: async (id) => { removed.push(id) },
    retryDelivery: async () => true,
    testChannel: async () => ({ ok: false, error: 'unreachable' }),
    testSmtp: async () => ({ ok: true }),
  }
  app = Fastify({ logger: false })
  await app.register(createNotifyRoutes(options), { prefix: '/n' })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  store.close()
})

async function addDelivery(eventType: string, values: Partial<typeof notificationDeliveries.$inferInsert> = {}) {
  const [row] = await store.db.insert(notificationDeliveries).values({
    channelId: 1, channelName: 'Chat', channelType: 'webhook', sourceId: 7, sourceName: 'Thing', eventType, status: 'failed',
    targetStatus: 'down', previousStatus: 'up', variables: '{}', maxAttempts: 3, createdAt: NOW, updatedAt: NOW, ...values,
  }).returning()
  return row!
}

describe('delivery history', () => {
  it('names what a delivery is about the way the application does, filter included', async () => {
    await addDelivery('alert')
    await addDelivery('alert', { sourceId: 8, sourceName: 'Other' })
    const all = (await app.inject('/n/deliveries')).json()
    assert.deepEqual(Object.keys(all.deliveries[0]).slice(0, 6), ['id', 'channelId', 'channelName', 'channelType', 'itemId', 'itemName'])
    const one = (await app.inject('/n/deliveries?itemId=8')).json()
    assert.deepEqual(one.deliveries.map((d: { itemName: string }) => d.itemName), ['Other'])
    const detail = (await app.inject('/n/deliveries/1')).json()
    assert.equal(detail.itemId, 7)
    assert.equal(detail.sourceId, undefined)
    assert.equal(detail.variables, undefined)
  })

  it('leaves out the event types the caller may not read and answers 404 for them', async () => {
    await addDelivery('alert')
    await addDelivery('secret-event')
    hidden = ['secret-event']
    assert.equal((await app.inject('/n/deliveries')).json().total, 1)
    assert.equal((await app.inject('/n/deliveries/2')).statusCode, 404)
    assert.equal((await app.inject({ method: 'POST', url: '/n/deliveries/2/retry' })).statusCode, 404)
  })

  it('retries only a failed delivery', async () => {
    await addDelivery('alert', { status: 'delivered' })
    assert.equal((await app.inject({ method: 'POST', url: '/n/deliveries/1/retry' })).statusCode, 409)
    await addDelivery('alert')
    assert.equal((await app.inject({ method: 'POST', url: '/n/deliveries/2/retry' })).statusCode, 200)
  })
})

describe('channels', () => {
  const create = (body: object) => app.inject({ method: 'POST', url: '/n/channels', payload: body })

  it('refuses a channel without a name, of an unknown type or with an unusable config', async () => {
    assert.equal((await create({ type: 'slack', config: {} })).statusCode, 400)
    assert.match((await create({ name: 'x', type: 'carrier-pigeon' })).json().error, /Type must be one of/)
    assert.match((await create({ name: 'x', type: 'telegram', config: { chatId: '1' } })).json().error, /Bot Token/)
  })

  it('creates a channel with the policy filled in under the application key, and refuses a taken key', async () => {
    const response = await create({ name: 'Team', type: 'slack', config: {}, alertPolicy: { grouping: { enabled: true, minItems: 5 } } })
    assert.equal(response.statusCode, 200)
    const channel = response.json()
    assert.equal(channel.key, 'team')
    assert.equal(channel.alertPolicy.grouping.minItems, 5)
    assert.equal((await create({ name: 'Team', type: 'slack', config: {} })).statusCode, 409)
    assert.equal((await app.inject({ method: 'PATCH', url: `/n/channels/${channel.id}`, payload: { key: 'other' } })).statusCode, 400)
  })

  it('needs a new config when the type changes, and tells the application a channel is going away', async () => {
    const { id } = (await create({ name: 'Team', type: 'slack', config: {} })).json()
    assert.equal((await app.inject({ method: 'PATCH', url: `/n/channels/${id}`, payload: { type: 'discord' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'DELETE', url: `/n/channels/${id}` })).statusCode, 204)
    assert.deepEqual(removed, [id])
    assert.equal((await app.inject(`/n/channels/${id}`)).statusCode, 404)
  })

  it('answers a failed test with 422 and the reason', async () => {
    const response = await app.inject({ method: 'POST', url: '/n/channels/1/test' })
    assert.equal(response.statusCode, 422)
    assert.equal(response.json().error, 'unreachable')
  })
})

describe('SMTP settings', () => {
  const save = (body: object) => app.inject({ method: 'PUT', url: '/n/smtp', payload: body })
  const settings = { host: 'mail.test', port: 25, secure: 0, user: 'u', password: 'pw', fromAddress: 'a@example.test', fromName: 'A' }

  it('shows the default sender before anything is saved and masks the password after', async () => {
    assert.equal((await app.inject('/n/smtp')).json().fromName, 'Alerts')
    await save(settings)
    assert.equal((await app.inject('/n/smtp')).json().password, '••••••••')
    assert.equal((await store.db.select().from(smtpSettings))[0]!.password, 'pw')
  })

  it('keeps the stored password when the mask comes back, but not for another server', async () => {
    await save(settings)
    assert.equal((await save({ ...settings, password: '••••••••', fromName: 'B' })).statusCode, 200)
    assert.equal((await store.db.select().from(smtpSettings))[0]!.password, 'pw')
    assert.equal((await save({ ...settings, password: '••••••••', host: 'other.test' })).statusCode, 400)
  })

  it('needs a recipient for a test mail', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/n/smtp/test', payload: {} })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: '/n/smtp/test', payload: { to: 'a@example.test' } })).statusCode, 200)
  })
})

