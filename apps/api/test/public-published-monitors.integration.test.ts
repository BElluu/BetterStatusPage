import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { db } from '../src/db/client.js'
import {
  incidentMonitors, incidents, layout, maintenanceWindowMonitors, maintenanceWindows, monitorDependencies, monitors,
} from '../src/db/schema.js'
import { publicRoutes } from '../src/routes/public.js'
import { refreshPublishedMonitorIds } from '../src/services/publishedMonitors.js'
import { sseService } from '../src/services/sse.service.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-published-monitors-test-')

const app = Fastify({ logger: false })
const ids: Record<string, number> = {}
let baseUrl = ''

before(async () => {
  initTestDb()
  const now = Date.now()
  const rows = await db.insert(monitors).values(['Website', 'Charted API', 'Internal DB', 'Internal cache'].map((name) => ({
    name, type: 'https', config: '{}', currentStatus: 'up', createdAt: now, updatedAt: now,
  }))).returning()
  for (const row of rows) ids[row.name] = row.id

  // Website is a status card inside a group, Charted API only appears as a chart; the rest is internal.
  await db.insert(layout).values({
    id: 1,
    updatedAt: now,
    tree: JSON.stringify({ id: 'root', type: 'page', children: [
      { id: 'g', type: 'group', label: 'Public', collapsible: false, children: [
        { id: 'w', type: 'monitor', monitorId: ids['Website'], showUptimeBar: true },
      ] },
      { id: 'c', type: 'chart', monitorId: ids['Charted API'], hours: 24, buckets: 30, aggregation: 'avg' },
    ] }),
  })

  const [incident] = await db.insert(incidents).values({ title: 'Mixed impact', status: 'investigating', impact: 'major', startedAt: now, createdAt: now, updatedAt: now }).returning()
  await db.insert(incidentMonitors).values([
    { incidentId: incident!.id, monitorId: ids['Website']! },
    { incidentId: incident!.id, monitorId: ids['Internal DB']! },
  ])
  ids['incident'] = incident!.id

  const windows = await db.insert(maintenanceWindows).values([
    { name: 'Internal only', startsAt: now - 60_000, endsAt: now + 3_600_000, createdAt: now, updatedAt: now },
    { name: 'Mixed window', startsAt: now - 60_000, endsAt: now + 3_600_000, createdAt: now, updatedAt: now },
    { name: 'Everything', startsAt: now - 60_000, endsAt: now + 3_600_000, createdAt: now, updatedAt: now },
  ]).returning()
  await db.insert(maintenanceWindowMonitors).values([
    { windowId: windows[0]!.id, monitorId: ids['Internal cache']! },
    { windowId: windows[1]!.id, monitorId: ids['Internal cache']! },
    { windowId: windows[1]!.id, monitorId: ids['Charted API']! },
  ])

  await db.insert(monitorDependencies).values([
    { dependentId: ids['Website']!, dependsOnId: ids['Charted API']! },
    { dependentId: ids['Website']!, dependsOnId: ids['Internal DB']! },
  ])

  await refreshPublishedMonitorIds()
  await app.register(rateLimit, { global: false })
  await app.register(publicRoutes, { prefix: '/public' })
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' })
})

after(async () => {
  sseService.closeAll()
  await app.close()
  teardownTestDb(testDb)
})

describe('public API exposes only published monitors', () => {
  it('filters monitors, incident links, maintenance windows and dependencies in /status', async () => {
    const status = (await app.inject({ url: '/public/status' })).json()
    assert.deepEqual(status.monitors.map((m: { name: string }) => m.name).sort(), ['Charted API', 'Website'])
    assert.doesNotMatch(JSON.stringify(status), /Internal/)
    assert.deepEqual(status.activeIncidents[0].monitorIds, [ids['Website']])

    const windows = Object.fromEntries(status.activeMaintenanceWindows.map((w: { name: string; monitorIds: number[] }) => [w.name, w.monitorIds]))
    assert.deepEqual(windows, { 'Mixed window': [ids['Charted API']], Everything: [] })

    assert.deepEqual(status.monitorDependencies.map((d: { dependsOnId: number }) => d.dependsOnId), [ids['Charted API']])
  })

  it('strips links to internal monitors from incident lists and details', async () => {
    const list = (await app.inject({ url: '/public/incidents' })).json()
    assert.deepEqual(list[0].monitorIds, [ids['Website']])
    const detail = (await app.inject({ url: `/public/incidents/${ids['incident']}` })).json()
    assert.deepEqual(detail.monitorIds, [ids['Website']])
  })

  it('serves history only for published monitors, charts included', async () => {
    for (const name of ['Website', 'Charted API']) {
      assert.equal((await app.inject({ url: `/public/monitor/${ids[name]}/uptime?days=7` })).statusCode, 200, name)
      assert.equal((await app.inject({ url: `/public/monitor/${ids[name]}/history` })).statusCode, 200, name)
    }
    assert.equal((await app.inject({ url: `/public/monitor/${ids['Internal DB']}/uptime` })).statusCode, 404)
    assert.equal((await app.inject({ url: `/public/monitor/${ids['Internal DB']}/history` })).statusCode, 404)
  })

  it('streams status changes of published monitors only and strips internal incident links', async () => {
    const controller = new AbortController()
    const response = await fetch(`${baseUrl}/public/events`, { signal: controller.signal })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let received = ''
    const readUntil = async (marker: string) => {
      while (!received.includes(marker)) {
        const { value, done } = await reader.read()
        if (done) throw new Error('stream ended')
        received += decoder.decode(value)
      }
    }
    await readUntil('event: ping')

    sseService.broadcast('monitor.status', { monitorId: ids['Internal DB'], status: 'down' })
    sseService.broadcast('monitor.status', { monitorId: ids['Website'], status: 'down' })
    sseService.broadcast('incident.updated', { id: ids['incident'], title: 'Mixed impact', monitorIds: [ids['Website'], ids['Internal DB']] })
    await readUntil('event: incident.updated')
    controller.abort()

    assert.doesNotMatch(received, new RegExp(`"monitorId":${ids['Internal DB']}\\b`))
    assert.match(received, new RegExp(`"monitorId":${ids['Website']}\\b`))
    assert.match(received, new RegExp(`"monitorIds":\\[${ids['Website']}\\]`))
  })

  it('publishes a monitor as soon as the layout includes it', async () => {
    await db.update(layout).set({ tree: JSON.stringify({ id: 'root', type: 'page', children: [
      { id: 'd', type: 'monitor', monitorId: ids['Internal DB'], showUptimeBar: true },
    ] }) })
    await refreshPublishedMonitorIds()
    assert.equal((await app.inject({ url: `/public/monitor/${ids['Internal DB']}/uptime` })).statusCode, 200)
    assert.equal((await app.inject({ url: `/public/monitor/${ids['Website']}/uptime` })).statusCode, 404)
  })
})
