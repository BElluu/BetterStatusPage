import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { db } from '../src/db/client.js'
import { incidentMonitors, incidents, maintenanceWindowMonitors, maintenanceWindows } from '../src/db/schema.js'
import { monitorRoutes } from '../src/routes/monitors.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-monitor-activity-test-')
const app = Fastify({ logger: false })

before(async () => {
  initTestDb()
  app.addHook('preHandler', async (request) => {
    request.user = { userId: 1, email: 'admin@example.test', role: 'admin' }
  })
  await app.register(monitorRoutes, { prefix: '/monitors' })
  await app.ready()
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

type Activity = { maintenance: boolean; incident: string | null; windows: Array<{ id: number; name: string; startsAt: number }> }
type Listed = Array<{ id: number; activity: Activity }>

describe('monitor activity', () => {
  it('reports a running maintenance window and the worst open published incident per monitor', async () => {
    const create = async (name: string) => (await app.inject({
      method: 'POST', url: '/monitors',
      payload: { name, type: 'https', config: { url: 'https://a.example.test', method: 'GET', expectedStatus: 200 } },
    })).json<{ id: number }>().id
    const [scoped, other, drafted] = [await create('Scoped'), await create('Other'), await create('Drafted')]
    const now = Date.now()
    const [win] = await db.insert(maintenanceWindows).values({ name: 'Work', startsAt: now - 1_000, endsAt: now + 60_000, createdAt: now, updatedAt: now }).returning()
    await db.insert(maintenanceWindowMonitors).values({ windowId: win!.id, monitorId: scoped })
    const base = { status: 'investigating', startedAt: now, createdAt: now, updatedAt: now }
    const [minor, critical, draft, resolved] = await db.insert(incidents).values([
      { title: 'a', impact: 'minor', draft: 0, ...base },
      { title: 'b', impact: 'critical', draft: 0, ...base },
      { title: 'c', impact: 'major', draft: 1, ...base },
      { title: 'd', impact: 'major', draft: 0, ...base, status: 'resolved' },
    ]).returning()
    await db.insert(incidentMonitors).values([
      { incidentId: minor!.id, monitorId: scoped }, { incidentId: critical!.id, monitorId: scoped },
      { incidentId: draft!.id, monitorId: drafted }, { incidentId: resolved!.id, monitorId: drafted },
    ])

    const list = (await app.inject({ method: 'GET', url: '/monitors' })).json<Listed>()
    const of = (id: number) => list.find((m) => m.id === id)!.activity
    const flags = (id: number) => ({ maintenance: of(id).maintenance, incident: of(id).incident })
    assert.deepEqual(flags(scoped), { maintenance: true, incident: 'critical' })
    assert.deepEqual(flags(other), { maintenance: false, incident: null })
    assert.deepEqual(flags(drafted), { maintenance: false, incident: null })
    assert.deepEqual(of(scoped).windows.map((w) => w.name), ['Work'])
    assert.deepEqual(of(other).windows, [])
    assert.deepEqual((await app.inject({ method: 'GET', url: `/monitors/${scoped}` })).json<Listed[number]>().activity.windows.map((w) => w.name), ['Work'])

    // An upcoming window is listed after the running one, without marking the monitor as in maintenance.
    const [later] = await db.insert(maintenanceWindows).values({ name: 'Later', startsAt: now + 3_600_000, endsAt: now + 7_200_000, createdAt: now, updatedAt: now }).returning()
    await db.insert(maintenanceWindowMonitors).values({ windowId: later!.id, monitorId: other })
    const withUpcoming = (await app.inject({ method: 'GET', url: '/monitors' })).json<Listed>()
    assert.deepEqual(withUpcoming.find((m) => m.id === other)!.activity.windows.map((w) => w.name), ['Later'])
    assert.equal(withUpcoming.find((m) => m.id === other)!.activity.maintenance, false)
    assert.deepEqual(withUpcoming.find((m) => m.id === scoped)!.activity.windows.map((w) => w.name), ['Work'])

    // A window without monitors covers all of them.
    await db.insert(maintenanceWindows).values({ name: 'Everything', startsAt: now - 1_000, endsAt: now + 60_000, createdAt: now, updatedAt: now })
    const all = (await app.inject({ method: 'GET', url: '/monitors' })).json<Listed>()
    assert.ok(all.every((m) => m.activity.maintenance))
  })
})

describe('monitor activity and token scopes', () => {
  it('leaves maintenance windows out for a token without the maintenance permission', async () => {
    assert.ok((await app.inject({ method: 'GET', url: '/monitors' })).json<Listed>().some((m) => m.activity.windows.length > 0))
    const scoped = Fastify({ logger: false })
    scoped.addHook('preHandler', async (request) => {
      request.user = { userId: 1, email: 't@example.test', role: 'admin', apiToken: { id: 1, scopes: ['monitors:read'] } } as never
    })
    await scoped.register(monitorRoutes, { prefix: '/monitors' })
    await scoped.ready()
    const list = (await scoped.inject({ method: 'GET', url: '/monitors' })).json<Listed>()
    assert.ok(list.every((m) => m.activity.windows.length === 0))
    await scoped.close()
  })
})
