import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { eq } from 'drizzle-orm'
import { db, sqlite } from '../src/db/client.js'
import { incidentMonitors, incidents, incidentTemplates, incidentUpdates, monitors, subscriberDeliveries } from '../src/db/schema.js'
import { incidentRoutes } from '../src/routes/incidents.js'
import { incidentTemplateRoutes } from '../src/routes/incidentTemplates.js'
import { feedRoutes } from '../src/routes/feeds.js'
import { publicRoutes } from '../src/routes/public.js'
import { statusApiRoutes } from '../src/routes/statusApi.js'
import { getSubscriptionSettings, normalizeSubscriptionSettings, saveSubscriptionSettings } from '../src/services/subscriptions.js'
import { notifyIncidentSubscribers } from '../src/workers/subscriberNotifier.js'
import { parseMonitorPatch, parseNewMonitor } from '../src/services/monitorInput.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-draft-incidents-')
const app = Fastify({ logger: false })

before(async () => {
  initTestDb()
  await saveSubscriptionSettings(normalizeSubscriptionSettings({ enabled: true }, await getSubscriptionSettings()))
  app.addHook('onRequest', async (request) => {
    request.user = { userId: 1, email: 'admin@example.test', role: 'admin', sessionId: 'test-session' }
  })
  await app.register(rateLimit, { global: false })
  await app.register(incidentRoutes, { prefix: '/admin/incidents' })
  await app.register(incidentTemplateRoutes, { prefix: '/admin/incident-templates' })
  await app.register(publicRoutes, { prefix: '/public' })
  await app.register(feedRoutes, { prefix: '/public' })
  await app.register(statusApiRoutes, { prefix: '/public' })
  await app.ready()
})
after(async () => { await app.close(); teardownTestDb(testDb) })
beforeEach(async () => {
  await db.delete(subscriberDeliveries)
  await db.delete(incidentUpdates)
  await db.delete(incidentMonitors)
  await db.delete(incidents)
  await db.delete(monitors)
  sqlite.exec('DELETE FROM incident_templates WHERE is_default = 0')
})

const createIncident = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/admin/incidents', payload })

describe('a draft incident', () => {
  it('stays out of the feeds and the status API', async () => {
    await createIncident({ title: 'Secret draft', draft: true })
    await createIncident({ title: 'Visible one' })
    for (const url of ['/public/incidents.rss', '/public/incidents.atom', '/public/slack.rss']) {
      const body = (await app.inject({ url })).body
      assert.match(body, /Visible one/, url)
      assert.doesNotMatch(body, /Secret draft/, url)
    }
    const summary = (await app.inject({ url: '/public/summary.json' })).body
    assert.match(summary, /Visible one/)
    assert.doesNotMatch(summary, /Secret draft/)
  })

  it('sends no subscriber notice, and publishing it sends one', async () => {
    const draft = (await createIncident({ title: 'Quiet', draft: true })).json() as { id: number; draft: boolean }
    assert.equal(draft.draft, true)
    assert.equal(await notifyIncidentSubscribers('incident.created', draft.id), 0)

    const published = await app.inject({ method: 'PATCH', url: `/admin/incidents/${draft.id}`, payload: { draft: false, notifySubscribers: false } })
    assert.equal(published.statusCode, 200)
    assert.equal(published.json().draft, false)
    const public_ = (await app.inject({ url: `/public/incidents/${draft.id}` })).statusCode
    assert.equal(public_, 200)
  })

  it('cannot be turned back from published, and the flag must be a boolean', async () => {
    const live = (await createIncident({ title: 'Live' })).json() as { id: number }
    const back = await app.inject({ method: 'PATCH', url: `/admin/incidents/${live.id}`, payload: { draft: true } })
    assert.equal(back.statusCode, 400)
    assert.equal((await createIncident({ title: 'x', draft: 'yes' })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PATCH', url: `/admin/incidents/${live.id}`, payload: { draft: 'no' } })).statusCode, 400)
  })
})

describe('incident templates', () => {
  it('cannot delete the default one, refuse a duplicate name, and send monitors back to the default on delete', async () => {
    const list = () => app.inject({ url: '/admin/incident-templates' }).then((r) => r.json() as Array<{ id: number; isDefault: boolean; name: string }>)
    const base = { title: 'T', body: 'B', resolvedBody: 'R', impact: 'minor' }
    const defaultId = (await list()).find((t) => t.isDefault)!.id
    assert.equal((await app.inject({ method: 'DELETE', url: `/admin/incident-templates/${defaultId}` })).statusCode, 409)

    const custom = (await app.inject({ method: 'POST', url: '/admin/incident-templates', payload: { ...base, name: 'Custom' } })).json() as { id: number }
    assert.equal((await app.inject({ method: 'POST', url: '/admin/incident-templates', payload: { ...base, name: 'Custom' } })).statusCode, 409)
    assert.equal((await app.inject({ method: 'POST', url: '/admin/incident-templates', payload: { ...base, name: 'Other', impact: 'huge' } })).statusCode, 400)

    const now = Date.now()
    const monitor = (await db.insert(monitors).values({
      name: 'M', type: 'webhook', config: '{}', currentStatus: 'up', autoIncidentMinutes: 5, autoIncidentTemplateId: custom.id, createdAt: now, updatedAt: now,
    }).returning())[0]!
    assert.equal((await app.inject({ method: 'DELETE', url: `/admin/incident-templates/${custom.id}` })).statusCode, 204)
    assert.equal((await db.select().from(monitors).where(eq(monitors.id, monitor.id)))[0]!.autoIncidentTemplateId, null)
    assert.equal((await db.select().from(incidentTemplates).where(eq(incidentTemplates.id, custom.id))).length, 0)
  })
})

describe('automatic incident settings of a monitor', () => {
  const body = { name: 'M', type: 'https', config: { url: 'https://example.test' } }
  it('default to off, draft and the default template', () => {
    const parsed = parseNewMonitor(body)
    assert.ok('value' in parsed)
    assert.deepEqual(
      [parsed.value.autoIncidentMinutes, parsed.value.autoIncidentMode, parsed.value.autoIncidentTemplateId],
      [null, 'draft', null],
    )
  })
  it('are validated on create and on update', () => {
    assert.ok('error' in parseNewMonitor({ ...body, autoIncidentMinutes: 0 }))
    assert.ok('error' in parseNewMonitor({ ...body, autoIncidentMinutes: 10_081 }))
    assert.ok('error' in parseNewMonitor({ ...body, autoIncidentMinutes: 1.5 }))
    assert.ok('error' in parseNewMonitor({ ...body, autoIncidentMode: 'public' }))
    assert.ok('error' in parseNewMonitor({ ...body, autoIncidentTemplateId: 'one' }))
    const existing = { type: 'https', failureThreshold: 1, recoveryThreshold: 1 }
    assert.ok('error' in parseMonitorPatch({ autoIncidentMode: 'x' }, existing))
    const patch = parseMonitorPatch({ autoIncidentMinutes: null, autoIncidentTemplateId: null }, existing)
    assert.ok('value' in patch)
    assert.deepEqual(patch.value, { autoIncidentMinutes: null, autoIncidentTemplateId: null })
  })
})
