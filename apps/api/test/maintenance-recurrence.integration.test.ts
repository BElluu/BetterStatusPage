import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { maintenanceRoutes } from '../src/routes/maintenance.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-maintenance-recurrence-test-')
const app = Fastify({ logger: false })

before(async () => {
  initTestDb()
  app.addHook('preHandler', async (request) => {
    request.user = { userId: 1, email: 'admin@example.test', role: 'admin' }
  })
  await app.register(maintenanceRoutes, { prefix: '/maintenance' })
  await app.ready()
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

const HOUR = 3_600_000
const DAY = 24 * HOUR

describe('recurring maintenance', () => {
  it('stores a weekly window and reports it active during a later occurrence', async () => {
    const startsAt = Date.now() - 14 * DAY
    const create = await app.inject({
      method: 'POST',
      url: '/maintenance',
      payload: { name: 'Backups', startsAt, endsAt: startsAt + HOUR, recurrence: 'daily', timezone: 'UTC', notifySubscribers: false },
    })
    assert.equal(create.statusCode, 200)
    const win = create.json<{ id: number; recurrence: string; recurrenceDays: number[] }>()
    assert.equal(win.recurrence, 'daily')
    assert.deepEqual(win.recurrenceDays, [])

    const minuteOfDay = (Date.now() - startsAt) % DAY
    const patch = await app.inject({ method: 'PATCH', url: `/maintenance/${win.id}`, payload: { recurrence: 'weekly', recurrenceDays: [3, 1, 1] } })
    assert.equal(patch.statusCode, 200)
    assert.deepEqual(patch.json<{ recurrenceDays: number[] }>().recurrenceDays, [1, 3])
    // Active only when today's weekday is chosen and the clock is inside the hour.
    const active = await app.inject({ method: 'GET', url: '/maintenance/active' })
    const insideHour = minuteOfDay < HOUR
    const chosen = [1, 3].includes(new Date().getUTCDay())
    assert.equal(active.json<unknown[]>().length, insideHour && chosen ? 1 : 0)
  })

  it('rejects an invalid recurrence', async () => {
    const base = { name: 'Bad', startsAt: Date.now(), endsAt: Date.now() + HOUR }
    const post = (extra: object) => app.inject({ method: 'POST', url: '/maintenance', payload: { ...base, ...extra } })
    assert.equal((await post({ recurrence: 'monthly' })).statusCode, 400)
    assert.equal((await post({ recurrence: 'weekly' })).statusCode, 400)
    assert.equal((await post({ recurrence: 'weekly', recurrenceDays: [7] })).statusCode, 400)
    assert.equal((await post({ recurrence: 'daily', timezone: 'Mars/Base' })).statusCode, 400)
    assert.equal((await post({ recurrence: 'daily', recurrenceUntil: 'never' })).statusCode, 400)
  })
})

describe('recurrence validation', () => {
  const base = () => ({ name: 'Check', startsAt: Date.now(), endsAt: Date.now() + HOUR, notifySubscribers: false })

  it('refuses occurrences that would overlap and an end before the start', async () => {
    const post = (extra: object) => app.inject({ method: 'POST', url: '/maintenance', payload: { ...base(), ...extra } })
    assert.equal((await post({ recurrence: 'daily', endsAt: Date.now() + 25 * HOUR })).statusCode, 400)
    // An hour under a day still fits when a local day has 23 hours; a whole day does not.
    assert.equal((await post({ recurrence: 'daily', endsAt: Date.now() + 23 * HOUR })).statusCode, 200)
    assert.equal((await post({ recurrence: 'daily', endsAt: Date.now() + 24 * HOUR })).statusCode, 400)
    assert.equal((await post({ recurrence: 'weekly', recurrenceDays: [1, 2], endsAt: Date.now() + 25 * HOUR })).statusCode, 400)
    assert.equal((await post({ recurrence: 'weekly', recurrenceDays: [1], endsAt: Date.now() + 3 * DAY })).statusCode, 200)
    assert.equal((await post({ recurrence: 'daily', recurrenceUntil: Date.now() - DAY })).statusCode, 400)
  })

  it('answers 400 to an update without a body', async () => {
    const id = (await app.inject({ method: 'POST', url: '/maintenance', payload: base() })).json<{ id: number }>().id
    assert.equal((await app.inject({ method: 'PATCH', url: `/maintenance/${id}` })).statusCode, 400)
  })

  it('keeps an early end through edits, including a moved start with the same time of day', async () => {
    const startsAt = Date.now() - 10 * 60_000 - 2 * DAY
    const created = await app.inject({
      method: 'POST', url: '/maintenance',
      payload: { name: 'Nightly', startsAt, endsAt: startsAt + 2 * HOUR, recurrence: 'daily', timezone: 'UTC', notifySubscribers: false },
    })
    const id = created.json<{ id: number }>().id
    const active = () => app.inject({ method: 'GET', url: '/maintenance/active' }).then((r) => r.json<Array<{ id: number }>>().some((w) => w.id === id))
    assert.equal((await app.inject({ method: 'POST', url: `/maintenance/${id}/end` })).statusCode, 200)
    assert.equal(await active(), false)
    // The edit form sends every field; unchanged schedule fields must not bring the window back.
    await app.inject({ method: 'PATCH', url: `/maintenance/${id}`, payload: { name: 'Nightly 2', startsAt, endsAt: startsAt + 2 * HOUR, recurrence: 'daily', timezone: 'UTC' } })
    assert.equal(await active(), false)
    // Moving the series start back a few days keeps the ended occurrence ended: it starts at the same instant.
    await app.inject({ method: 'PATCH', url: `/maintenance/${id}`, payload: { startsAt: startsAt - 3 * DAY, endsAt: startsAt - 3 * DAY + 2 * HOUR } })
    assert.equal(await active(), false)
    await app.inject({ method: 'PATCH', url: `/maintenance/${id}`, payload: { recurrence: 'weekly', recurrenceDays: [0, 1, 2, 3, 4, 5, 6] } })
    assert.equal(await active(), false)
  })
})

describe('ending a window early', () => {
  it('ends a one-off window by moving its end to now', async () => {
    const now = Date.now()
    const created = await app.inject({
      method: 'POST', url: '/maintenance',
      payload: { name: 'Once', startsAt: now - HOUR, endsAt: now + HOUR, notifySubscribers: false },
    })
    const id = created.json<{ id: number }>().id
    assert.equal((await app.inject({ method: 'GET', url: '/maintenance/active' })).json<Array<{ id: number }>>().some((w) => w.id === id), true)
    assert.equal((await app.inject({ method: 'POST', url: `/maintenance/${id}/end` })).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/maintenance/active' })).json<Array<{ id: number }>>().some((w) => w.id === id), false)
    assert.equal((await app.inject({ method: 'POST', url: `/maintenance/${id}/end` })).statusCode, 409)
    assert.equal((await app.inject({ method: 'POST', url: '/maintenance/999999/end' })).statusCode, 404)
  })

  it('ends only the running occurrence of a repeating window', async () => {
    // Daily window whose latest occurrence started 10 minutes ago and lasts two hours.
    const now = Date.now()
    const startsAt = now - 10 * 60_000 - 3 * DAY
    const created = await app.inject({
      method: 'POST', url: '/maintenance',
      payload: { name: 'Nightly', startsAt, endsAt: startsAt + 2 * HOUR, recurrence: 'daily', notifySubscribers: false },
    })
    const id = created.json<{ id: number }>().id
    const active = () => app.inject({ method: 'GET', url: '/maintenance/active' }).then((r) => r.json<Array<{ id: number }>>().some((w) => w.id === id))
    assert.equal(await active(), true)
    assert.equal((await app.inject({ method: 'POST', url: `/maintenance/${id}/end` })).statusCode, 200)
    assert.equal(await active(), false)
    const window = (await app.inject({ method: 'GET', url: `/maintenance/${id}` })).json<{ recurrence: string; occurrence: { startsAt: number } }>()
    assert.equal(window.recurrence, 'daily')
    assert.ok(window.occurrence.startsAt > now)
  })
})

describe('a repeating window that starts later', () => {
  it('is listed with its first occurrence and is not active yet', async () => {
    const startsAt = Date.now() + 30 * DAY
    const created = await app.inject({
      method: 'POST', url: '/maintenance',
      payload: { name: 'Next month', startsAt, endsAt: startsAt + HOUR, recurrence: 'daily', timezone: 'UTC', notifySubscribers: false },
    })
    const body = created.json<{ id: number; occurrence: { startsAt: number } }>()
    assert.equal(body.occurrence.startsAt, startsAt)
    const active = (await app.inject({ method: 'GET', url: '/maintenance/active' })).json<Array<{ id: number }>>()
    assert.equal(active.some((w) => w.id === body.id), false)
  })
})
