import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { FastifyReply } from 'fastify'
import { eq } from 'drizzle-orm'
import { db, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import {
  maintenanceWindowMonitors, maintenanceWindows, monitorDependencies, monitorResults, monitors,
} from '../src/db/schema.js'
import { sseService } from '../src/services/sse.service.js'
import {
  getDueMonitors, getSchedulerHealth, isInMaintenance, purgeOldResults, runCheck, runSchedulerTick,
} from '../src/workers/scheduler.js'

const dataDir = mkdtempSync(join(tmpdir(), 'bsp-scheduler-test-'))
process.env['DATABASE_PATH'] = join(dataDir, 'test.sqlite')

let requestCount = 0
const server = createServer((_req, response) => {
  requestCount++
  response.writeHead(requestCount === 1 ? 503 : 200)
  response.end(requestCount === 1 ? 'retry' : 'ok')
})
let baseUrl = ''

function monitorValues(name: string, overrides: Partial<typeof monitors.$inferInsert> = {}): typeof monitors.$inferInsert {
  const now = Date.now()
  return {
    name,
    type: 'webhook',
    intervalSecs: 60,
    timeoutMs: 1_000,
    retries: 1,
    config: '{}',
    currentStatus: 'pending',
    tags: '[]',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

before(async () => {
  initDb()
  runMigrations()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

beforeEach(async () => {
  await db.delete(maintenanceWindowMonitors)
  await db.delete(maintenanceWindows)
  await db.delete(monitorDependencies)
  await db.delete(monitorResults)
  await db.delete(monitors)
  requestCount = 0
})

after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('scheduler checks', () => {
  it('retries a failed check, persists recovery, and broadcasts SSE', async () => {
    const [monitor] = await db.insert(monitors).values(monitorValues('Retrying HTTP', {
      type: 'https',
      retries: 2,
      config: JSON.stringify({ url: baseUrl, method: 'GET', expectedStatus: 200 }),
      currentStatus: 'down',
    })).returning()
    const messages: string[] = []
    const client = { raw: { write: (message: string) => messages.push(message) } } as unknown as FastifyReply
    sseService.add(client)

    await runCheck(monitor!)
    sseService.remove(client)

    assert.equal(requestCount, 2)
    const stored = (await db.select().from(monitors).where(eq(monitors.id, monitor!.id)))[0]!
    assert.equal(stored.currentStatus, 'up')
    assert.equal((await db.select().from(monitorResults))[0]!.status, 'up')
    assert.match(messages[0] ?? '', /"status":"up"/)
  })

  it('marks a monitor affected when its dependency is unavailable', async () => {
    requestCount = 1
    const [dependency, dependent] = await db.insert(monitors).values([
      monitorValues('Database', { currentStatus: 'down' }),
      monitorValues('API', {
        type: 'https',
        config: JSON.stringify({ url: baseUrl, method: 'GET', expectedStatus: 200 }),
      }),
    ]).returning()
    await db.insert(monitorDependencies).values({ dependentId: dependent!.id, dependsOnId: dependency!.id })

    await runCheck(dependent!)

    const stored = (await db.select().from(monitors).where(eq(monitors.id, dependent!.id)))[0]!
    assert.equal(stored.currentStatus, 'affected')
    assert.equal((await db.select().from(monitorResults))[0]!.status, 'affected')
  })
})

describe('scheduler orchestration', () => {
  it('selects only due monitors', () => {
    const now = Date.now()
    const base = monitorValues('base') as typeof monitors.$inferSelect
    const due = getDueMonitors([
      { ...base, id: 1, lastCheckedAt: null },
      { ...base, id: 2, lastCheckedAt: now - 61_000 },
      { ...base, id: 3, lastCheckedAt: now - 10_000 },
    ], now)
    assert.deepEqual(due.map((monitor) => monitor.id), [1, 2])
  })

  it('processes checks in configurable chunks', async () => {
    const now = Date.now()
    await db.insert(monitors).values([
      ...Array.from({ length: 25 }, (_, index) => monitorValues(`Due ${index}`)),
      monitorValues('Not due', { lastCheckedAt: now }),
    ])
    let active = 0
    let maxActive = 0
    let checked = 0

    await runSchedulerTick(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      checked++
    }, { tickCron: '*/10 * * * * *', resultPurgeCron: '0 2 * * *', resultRetentionDays: 90, checkConcurrency: 7 })

    assert.equal(checked, 25)
    assert.equal(maxActive, 7)
    const health = getSchedulerHealth()
    assert.equal(health.lastDueMonitors, 25)
    assert.equal(health.lastFailedChecks, 0)
    assert.equal(health.lastTickFailed, false)
    assert.ok(health.lastStartedAt)
    assert.ok(health.lastCompletedAt)
    assert.ok(health.lastDurationMs !== null)
  })

  it('purges results older than 90 days', async () => {
    const [monitor] = await db.insert(monitors).values(monitorValues('Retention')).returning()
    const now = Date.now()
    await db.insert(monitorResults).values([
      { monitorId: monitor!.id, status: 'up', responseMs: 1, checkedAt: now - 91 * 86_400_000, errorMessage: null },
      { monitorId: monitor!.id, status: 'up', responseMs: 1, checkedAt: now - 89 * 86_400_000, errorMessage: null },
    ])

    await purgeOldResults(now, { tickCron: '*/10 * * * * *', resultPurgeCron: '0 2 * * *', resultRetentionDays: 90, checkConcurrency: 20 })
    const remaining = await db.select().from(monitorResults)
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0]!.checkedAt, now - 89 * 86_400_000)
  })
})

describe('maintenance matching', () => {
  it('supports scoped, global, future, and expired windows', async () => {
    const [first, second] = await db.insert(monitors).values([monitorValues('First'), monitorValues('Second')]).returning()
    const now = Date.now()
    const [scoped] = await db.insert(maintenanceWindows).values({
      name: 'Scoped', startsAt: now - 1_000, endsAt: now + 1_000, createdAt: now, updatedAt: now,
    }).returning()
    await db.insert(maintenanceWindowMonitors).values({ windowId: scoped!.id, monitorId: first!.id })

    assert.equal(await isInMaintenance(first!.id, now), true)
    assert.equal(await isInMaintenance(second!.id, now), false)

    await db.insert(maintenanceWindows).values({
      name: 'Global', startsAt: now - 1_000, endsAt: now + 1_000, createdAt: now, updatedAt: now,
    })
    assert.equal(await isInMaintenance(second!.id, now), true)
    assert.equal(await isInMaintenance(second!.id, now + 2_000), false)
  })
})
