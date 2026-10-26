import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { after, before, beforeEach, describe, it } from 'node:test'
import { db } from '../src/db/client.js'
import { monitorNotificationChannels, monitors, notificationChannels, notificationDeliveries, notificationDeliveryAttempts } from '../src/db/schema.js'
import { drainScheduler, recordObservation } from '../src/workers/scheduler.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-alert-durability-test-')
const held: ServerResponse[] = []
const received: string[] = []
const server = createServer((request, response) => {
  received.push(request.url ?? '')
  // /hang answers only once the test lets it, like a channel whose endpoint stalls.
  if (request.url === '/hang') held.push(response)
  else response.writeHead(204).end()
})
let baseUrl = ''

before(async () => {
  initTestDb()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

beforeEach(async () => {
  held.length = 0
  received.length = 0
  await db.delete(notificationDeliveryAttempts)
  await db.delete(notificationDeliveries)
  await db.delete(monitorNotificationChannels)
  await db.delete(notificationChannels)
  await db.delete(monitors)
})

after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  teardownTestDb(testDb)
})

describe('a confirmed alert', () => {
  it('is recorded for every channel before any of them is sent, and sent side by side', async () => {
    const now = Date.now()
    const [monitor] = await db.insert(monitors).values({
      name: 'Durable', type: 'webhook', intervalSecs: 60, timeoutMs: 1_000, retries: 1,
      config: '{}', currentStatus: 'up', tags: '[]', createdAt: now, updatedAt: now,
    }).returning()
    // The hanging channel comes first: before the change the second channel's delivery was not even recorded until it finished.
    for (const path of ['/hang', '/ok']) {
      const [channel] = await db.insert(notificationChannels).values({
        name: path, type: 'webhook', enabled: 1, notifyOnRecovery: 1, createdAt: now, updatedAt: now,
        config: JSON.stringify({ url: `${baseUrl}${path}`, method: 'POST', body: '{}' }),
      }).returning()
      await db.insert(monitorNotificationChannels).values({ monitorId: monitor!.id, channelId: channel!.id })
    }

    for (let attempt = 0; attempt < 5 && (await db.select().from(notificationDeliveries)).length === 0; attempt++) {
      await recordObservation(monitor!, { status: 'down', responseMs: null, error: 'boom' })
    }

    // The observation is back while the first channel is still hanging: both deliveries are already on record.
    const rows = await db.select().from(notificationDeliveries)
    assert.deepEqual(rows.map((row) => row.channelName).sort(), ['/hang', '/ok'])

    // The hanging channel did not hold up the other one.
    while (!received.includes('/ok')) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(held.length, 1)

    // Shutdown waits for the send that is still running.
    let drained = false
    const draining = drainScheduler().then(() => { drained = true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(drained, false)
    held[0]!.writeHead(204).end()
    await draining
    assert.deepEqual((await db.select().from(notificationDeliveries)).map((row) => row.status), ['delivered', 'delivered'])
  })
})
