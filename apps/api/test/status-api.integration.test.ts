import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { db, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import {
  incidentMonitors, incidents, layout, maintenanceWindowMonitors, maintenanceWindows, monitors,
} from '../src/db/schema.js'
import { statusApiRoutes } from '../src/routes/statusApi.js'
import { getSubscriptionSettings, normalizeSubscriptionSettings, saveSubscriptionSettings } from '../src/services/subscriptions.js'

const dataDir = mkdtempSync(join(tmpdir(), 'bsp-status-api-test-'))
process.env['DATABASE_PATH'] = join(dataDir, 'test.sqlite')

const app = Fastify({ logger: false })
const ids: Record<string, number> = {}
const HOUR = 3_600_000

before(async () => {
  initDb()
  runMigrations()
  const now = Date.now()
  const rows = await db.insert(monitors).values([
    { name: 'API', type: 'https', config: '{}', currentStatus: 'up', createdAt: now, updatedAt: now },
    { name: 'Web', type: 'https', config: '{}', currentStatus: 'up', createdAt: now, updatedAt: now },
    { name: 'Search', type: 'https', config: '{}', currentStatus: 'down', createdAt: now, updatedAt: now },
    { name: 'Billing', type: 'https', config: '{}', currentStatus: 'up', createdAt: now, updatedAt: now },
    { name: 'Internal DB', type: 'https', config: '{}', currentStatus: 'down', createdAt: now, updatedAt: now },
  ]).returning()
  for (const row of rows) ids[row.name] = row.id

  await db.insert(layout).values({
    id: 1,
    tree: JSON.stringify({
      id: 'root', type: 'page', children: [
        { id: 'n-api', type: 'monitor', monitorId: ids['API'], showUptimeBar: true },
        { id: 'core', type: 'group', label: 'Core', collapsible: false, children: [
          { id: 'n-web', type: 'monitor', monitorId: ids['Web'], showUptimeBar: true },
          { id: 'n-search', type: 'monitor', monitorId: ids['Search'], showUptimeBar: true },
        ] },
        { id: 'n-billing', type: 'monitor', monitorId: ids['Billing'], showUptimeBar: true },
      ],
    }),
    updatedAt: now,
  })

  const [incident] = await db.insert(incidents).values({
    title: 'Slow API', status: 'identified', impact: 'minor', startedAt: now - HOUR, createdAt: now - HOUR, updatedAt: now,
  }).returning()
  await db.insert(incidentMonitors).values([
    { incidentId: incident!.id, monitorId: ids['API']! },
    { incidentId: incident!.id, monitorId: ids['Internal DB']! },
  ])
  await db.insert(incidents).values({
    title: 'Old outage', status: 'resolved', impact: 'critical', startedAt: now - 48 * HOUR, resolvedAt: now - 47 * HOUR, createdAt: now, updatedAt: now,
  })

  const [running] = await db.insert(maintenanceWindows).values({
    name: 'Billing upgrade', startsAt: now - HOUR, endsAt: now + HOUR, description: 'Card processor swap', createdAt: now, updatedAt: now,
  }).returning()
  await db.insert(maintenanceWindowMonitors).values({ windowId: running!.id, monitorId: ids['Billing']! })
  await db.insert(maintenanceWindows).values([
    { name: 'Network work', startsAt: now + 24 * HOUR, endsAt: now + 26 * HOUR, description: null, createdAt: now, updatedAt: now },
    { name: 'Finished', startsAt: now - 5 * HOUR, endsAt: now - 4 * HOUR, description: null, createdAt: now, updatedAt: now },
  ])

  process.env['PUBLIC_URL'] = 'https://status.example.test'
  await saveSubscriptionSettings(normalizeSubscriptionSettings({ enabled: true }, await getSubscriptionSettings()))
  await app.register(rateLimit, { global: false })
  await app.register(statusApiRoutes, { prefix: '/api/v1/public' })
  await app.ready()
})

after(async () => {
  await app.close()
  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('public status API', () => {
  it('summarizes page status, active incidents and current or upcoming maintenance', async () => {
    const response = await app.inject({ url: '/api/v1/public/summary.json' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['access-control-allow-origin'], '*')
    const summary = response.json()
    assert.deepEqual(summary.page, { name: 'Status Page', url: 'https://status.example.test/', status: 'has_issues' })

    assert.equal(summary.activeIncidents.length, 1)
    const [incident] = summary.activeIncidents
    assert.equal(incident.name, 'Slow API')
    assert.equal(incident.status, 'identified')
    // Monitors that are not on the public page are never named.
    assert.deepEqual(incident.components, [{ id: ids['API'], name: 'API' }])

    assert.deepEqual(summary.activeMaintenances.map((m: { name: string; status: string; duration: number }) => [m.name, m.status, m.duration]), [
      ['Billing upgrade', 'in_progress', 120],
      ['Network work', 'not_started', 120],
    ])
    assert.doesNotMatch(response.body, /Internal DB|Old outage|Finished/)
  })

  it('lists public components with the statuses visitors see, grouped as on the page', async () => {
    const response = await app.inject({ url: '/api/v1/public/components.json' })
    assert.equal(response.statusCode, 200)
    const { components } = response.json()
    assert.deepEqual(components.map((c: { id: unknown; status: string }) => [c.id, c.status]), [
      [ids['API'], 'degraded_performance'],
      ['group:core', 'partial_outage'],
      [ids['Billing'], 'under_maintenance'],
    ])
    const core = components[1]
    assert.equal(core.name, 'Core')
    assert.equal(core.isParent, true)
    assert.deepEqual(core.children.map((c: { name: string; status: string }) => [c.name, c.status]), [
      ['Web', 'operational'],
      ['Search', 'major_outage'],
    ])
    assert.doesNotMatch(response.body, /Internal DB/)
  })

  it('can be switched off by operators', async () => {
    await saveSubscriptionSettings(normalizeSubscriptionSettings({ apiEnabled: false }, await getSubscriptionSettings()))
    assert.equal((await app.inject({ url: '/api/v1/public/summary.json' })).statusCode, 404)
    assert.equal((await app.inject({ url: '/api/v1/public/components.json' })).statusCode, 404)
  })
})
