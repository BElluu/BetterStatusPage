import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { db } from '../src/db/client.js'
import { layout, maintenanceWindowMonitors, maintenanceWindows, monitors } from '../src/db/schema.js'
import { loadPublicMaintenances, PUBLIC_PAST_MAINTENANCES } from '../src/services/publicStatusData.js'
import { publicRoutes } from '../src/routes/public.js'
import { refreshPublishedMonitorIds } from '../src/services/publishedMonitors.js'
import { sseService } from '../src/kit/sse.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-public-maintenances-test-')
const app = Fastify({ logger: false })
const HOUR = 3_600_000

before(async () => {
  initTestDb()
  const now = Date.now()
  const [site, internal] = await db.insert(monitors).values(['Website', 'Internal DB'].map((name) => ({
    name, type: 'https', config: '{}', currentStatus: 'up', createdAt: now, updatedAt: now,
  }))).returning()
  await db.insert(layout).values({
    id: 1, updatedAt: now,
    tree: JSON.stringify({ id: 'root', type: 'page', children: [{ id: 'w', type: 'monitor', monitorId: site!.id, showUptimeBar: true }] }),
  })
  const windows = await db.insert(maintenanceWindows).values([
    { name: 'Running', startsAt: now - HOUR, endsAt: now + HOUR, createdAt: now, updatedAt: now },
    { name: 'Later', startsAt: now + 48 * HOUR, endsAt: now + 49 * HOUR, createdAt: now, updatedAt: now },
    { name: 'Soon', startsAt: now + 2 * HOUR, endsAt: now + 3 * HOUR, createdAt: now, updatedAt: now },
    { name: 'Done', startsAt: now - 5 * HOUR, endsAt: now - 4 * HOUR, createdAt: now, updatedAt: now },
    { name: 'Internal only', startsAt: now + HOUR, endsAt: now + 2 * HOUR, createdAt: now, updatedAt: now },
    { name: 'Daily', startsAt: now - 30 * 24 * HOUR, endsAt: now - 30 * 24 * HOUR + HOUR, recurrence: 'daily', createdAt: now, updatedAt: now },
  ]).returning()
  await db.insert(maintenanceWindowMonitors).values([
    { windowId: windows[2]!.id, monitorId: site!.id },
    { windowId: windows[4]!.id, monitorId: internal!.id },
  ])
  await refreshPublishedMonitorIds()
  await app.register(rateLimit, { global: false })
  await app.register(publicRoutes, { prefix: '/public' })
})

after(async () => {
  sseService.closeAll()
  await app.close()
  teardownTestDb(testDb)
})

describe('GET /public/maintenances', () => {
  it('lists running and upcoming windows by start, then past one-off windows, without internal-only ones', async () => {
    const list = (await app.inject({ url: '/public/maintenances' })).json() as Array<{ name: string; state: string; monitorIds: number[] }>
    const names = list.map((win) => `${win.name}:${win.state}`)
    assert.equal(names.filter((n) => n.endsWith(':past')).join(), 'Done:past')
    assert.deepEqual(names.slice(0, -1).filter((n) => !n.startsWith('Daily')), ['Running:active', 'Soon:upcoming', 'Later:upcoming'])
    assert.ok(names.some((n) => n.startsWith('Daily:')), 'a repeating window shows its running or next occurrence')
    assert.ok(!names.some((n) => n.startsWith('Internal only')))
    assert.equal(list.find((win) => win.name === 'Running')!.monitorIds.length, 0)
    for (const win of list) assert.deepEqual(Object.keys(win).sort(), ['description', 'endsAt', 'id', 'monitorIds', 'name', 'startsAt', 'state'])
  })
})

describe('the cache of GET /public/maintenances', () => {
  it('is dropped when a window changes, and answers with a short Cache-Control meanwhile', async () => {
    await db.delete(maintenanceWindows)
    // The test before this one left a copy in the cache.
    sseService.broadcast('maintenance.changed', { id: 0 })
    const first = await app.inject({ url: '/public/maintenances' })
    assert.match(String(first.headers['cache-control']), /^public, max-age=2/)
    assert.deepEqual(first.json(), [])
    const now = Date.now()
    await db.insert(maintenanceWindows).values({ name: 'Cached', startsAt: now + HOUR, endsAt: now + 2 * HOUR, createdAt: now, updatedAt: now })
    assert.deepEqual((await app.inject({ url: '/public/maintenances' })).json(), [])
    sseService.broadcast('maintenance.changed', { id: 1 })
    assert.deepEqual((await app.inject({ url: '/public/maintenances' })).json<Array<{ name: string }>>().map((w) => w.name), ['Cached'])
  })
})

describe('loadPublicMaintenances', () => {
  const DAY = 24 * HOUR
  // A fixed, clean instant: 2031-01-15 12:00 UTC.
  const at = Date.UTC(2031, 0, 15, 12)
  let published = 0
  let internal = 0

  before(async () => {
    published = (await db.select().from(monitors)).find((m) => m.name === 'Website')!.id
    internal = (await db.select().from(monitors)).find((m) => m.name === 'Internal DB')!.id
    await db.delete(maintenanceWindows)
  })

  const add = async (values: Partial<typeof maintenanceWindows.$inferInsert> & { name: string; startsAt: number; endsAt: number }, monitorIds: number[] = []) => {
    const [row] = await db.insert(maintenanceWindows).values({ createdAt: at, updatedAt: at, ...values }).returning()
    if (monitorIds.length) await db.insert(maintenanceWindowMonitors).values(monitorIds.map((monitorId) => ({ windowId: row!.id, monitorId })))
    return row!
  }

  it('lists only the published monitors of a window that also covers an internal one', async () => {
    await db.delete(maintenanceWindows)
    await add({ name: 'Mixed', startsAt: at + HOUR, endsAt: at + 2 * HOUR }, [published, internal])
    const [win] = await loadPublicMaintenances(at)
    assert.deepEqual(win!.monitorIds, [published])
    assert.equal(win!.state, 'upcoming')
  })

  it('shows a daily window with the span and state of its running or next occurrence', async () => {
    await db.delete(maintenanceWindows)
    // Every day 11:30-12:30 UTC from 30 days ago.
    const first = Date.UTC(2030, 11, 16, 11, 30)
    await add({ name: 'Daily', startsAt: first, endsAt: first + HOUR, recurrence: 'daily', timezone: 'UTC' })
    const running = await loadPublicMaintenances(at)
    assert.deepEqual(running.map((w) => [w.state, w.startsAt, w.endsAt]), [['active', Date.UTC(2031, 0, 15, 11, 30), Date.UTC(2031, 0, 15, 12, 30)]])
    const next = await loadPublicMaintenances(at + HOUR)
    assert.deepEqual(next.map((w) => [w.state, w.startsAt]), [['upcoming', Date.UTC(2031, 0, 16, 11, 30)]])
  })

  it('moves a one-off window that was ended early to past, and a repeating one to its next occurrence', async () => {
    await db.delete(maintenanceWindows)
    await add({ name: 'One-off', startsAt: at - HOUR, endsAt: at, })
    const first = Date.UTC(2031, 0, 14, 11, 30)
    await add({ name: 'Daily', startsAt: first, endsAt: first + HOUR, recurrence: 'daily', timezone: 'UTC', endedEarlyStart: Date.UTC(2031, 0, 15, 11, 30), endedEarlyAt: at - 1 })
    const list = await loadPublicMaintenances(at + 1)
    assert.deepEqual(list.map((w) => [w.name, w.state]), [['Daily', 'upcoming'], ['One-off', 'past']])
    assert.equal(list[0]!.startsAt, Date.UTC(2031, 0, 16, 11, 30))
  })

  it('leaves out a repeating window whose last occurrence is over', async () => {
    await db.delete(maintenanceWindows)
    const first = Date.UTC(2031, 0, 1, 10)
    await add({ name: 'Ended series', startsAt: first, endsAt: first + HOUR, recurrence: 'daily', timezone: 'UTC', recurrenceUntil: first + 2 * DAY })
    assert.deepEqual(await loadPublicMaintenances(at), [])
  })

  it('keeps the newest past windows that visitors may see, newest first, even behind internal-only ones', async () => {
    await db.delete(maintenanceWindows)
    // Oldest: 3 public ones; newer: more than a page of internal-only ones.
    for (let i = 0; i < 3; i++) await add({ name: `Public ${i}`, startsAt: at - 100 * DAY - i * DAY, endsAt: at - 100 * DAY - i * DAY + HOUR })
    for (let i = 0; i < PUBLIC_PAST_MAINTENANCES + 5; i++) await add({ name: `Internal ${i}`, startsAt: at - 10 * DAY - i * HOUR * 2, endsAt: at - 10 * DAY - i * HOUR * 2 + HOUR }, [internal])
    const list = await loadPublicMaintenances(at)
    assert.deepEqual(list.map((w) => w.name), ['Public 0', 'Public 1', 'Public 2'])

    for (let i = 0; i < PUBLIC_PAST_MAINTENANCES + 2; i++) await add({ name: `Recent ${i}`, startsAt: at - 2 * DAY - i * HOUR * 2, endsAt: at - 2 * DAY - i * HOUR * 2 + HOUR })
    const capped = await loadPublicMaintenances(at)
    assert.equal(capped.length, PUBLIC_PAST_MAINTENANCES)
    assert.equal(capped[0]!.name, 'Recent 0')
    assert.ok(capped.every((w) => w.state === 'past' && w.name.startsWith('Recent')))
  })
})
