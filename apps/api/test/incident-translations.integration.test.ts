import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { eq } from 'drizzle-orm'
import { db, sqlite } from '../src/db/client.js'
import { incidentMonitors, incidents, incidentTemplates, incidentUpdates, layout, locales, monitorResults, monitors } from '../src/db/schema.js'
import { recordObservation } from '../src/workers/scheduler.js'
import { incidentRoutes } from '../src/routes/incidents.js'
import { incidentTemplateRoutes } from '../src/routes/incidentTemplates.js'
import { publicRoutes } from '../src/routes/public.js'
import { refreshPublishedMonitorIds } from '../src/services/publishedMonitors.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-incident-translations-')
const down = { status: 'down' as const, responseMs: null, error: 'refused' }
const up = { status: 'up' as const, responseMs: 10, error: null }
const app = Fastify({ logger: false })

const reload = async (id: number) => (await db.select().from(monitors).where(eq(monitors.id, id)))[0]!

before(async () => {
  initTestDb()
  const now = Date.now()
  await db.insert(locales).values({ code: 'pl', name: 'Polski', isDefault: 0, translations: '{}', updatedAt: now })
  app.addHook('onRequest', async (request) => {
    request.user = { userId: 1, email: 'admin@example.test', role: 'admin', sessionId: 'test-session' }
  })
  await app.register(rateLimit, { global: false })
  await app.register(incidentRoutes, { prefix: '/admin/incidents' })
  await app.register(incidentTemplateRoutes, { prefix: '/admin/incident-templates' })
  await app.register(publicRoutes, { prefix: '/public' })
  await app.ready()
})
after(async () => { await app.close(); teardownTestDb(testDb) })
beforeEach(async () => {
  await db.delete(incidentUpdates)
  await db.delete(incidentMonitors)
  await db.delete(incidents)
  await db.delete(monitorResults)
  await db.delete(monitors)
  await db.delete(layout)
  sqlite.exec('DELETE FROM incident_templates WHERE is_default = 0')
})

describe('incident template translations', () => {
  const create = (translations: unknown) => app.inject({
    method: 'POST', url: '/admin/incident-templates',
    payload: { name: 'Pay', title: 'T', body: 'B', resolvedBody: 'R', impact: 'major', translations },
  })

  it('stores wording for the other languages of the status page', async () => {
    const response = await create({ pl: { title: 'Tytuł', body: 'Treść', resolvedBody: '', extra: 'x' } })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json().translations, { pl: { title: 'Tytuł', body: 'Treść' } })
    const listed = (await app.inject({ method: 'GET', url: '/admin/incident-templates' })).json() as Array<{ name: string; translations: unknown }>
    assert.deepEqual(listed.find((t) => t.name === 'Pay')!.translations, { pl: { title: 'Tytuł', body: 'Treść' } })
  })

  it('refuses a language that is not installed, the default one, and a wrong shape', async () => {
    assert.equal((await create({ de: { title: 'x' } })).statusCode, 400)
    assert.equal((await create({ en: { title: 'x' } })).statusCode, 400)
    assert.equal((await create({ pl: 'x' })).statusCode, 400)
    assert.equal((await create({ pl: { title: 5 } })).statusCode, 400)
    assert.equal((await create(['pl'])).statusCode, 400)
  })

  it('keeps the translations when a patch does not mention them, and replaces them when it does', async () => {
    const id = (await create({ pl: { title: 'Tytuł' } })).json().id as number
    await app.inject({ method: 'PATCH', url: `/admin/incident-templates/${id}`, payload: { name: 'Pay 2' } })
    const kept = (await app.inject({ method: 'GET', url: '/admin/incident-templates' })).json() as Array<{ id: number; translations: unknown }>
    assert.deepEqual(kept.find((t) => t.id === id)!.translations, { pl: { title: 'Tytuł' } })
    await app.inject({ method: 'PATCH', url: `/admin/incident-templates/${id}`, payload: { translations: {} } })
    const cleared = (await app.inject({ method: 'GET', url: '/admin/incident-templates' })).json() as Array<{ id: number; translations: unknown }>
    assert.deepEqual(cleared.find((t) => t.id === id)!.translations, {})
  })
})

describe('translated automatic incidents', () => {
  async function outage() {
    const now = Date.now()
    const template = (await db.insert(incidentTemplates).values({
      name: 'Pay', title: '{{monitor}} is down', body: 'Down for {{duration}}', resolvedBody: 'Back after {{duration}}', impact: 'major',
      translations: JSON.stringify({
        pl: { title: '{{monitor}} nie działa', body: 'Awaria trwa {{duration}}' },
        de: { title: 'nicht installiert' },
      }),
      isDefault: 0, createdAt: now, updatedAt: now,
    }).returning())[0]!
    const monitor = (await db.insert(monitors).values({
      name: 'API', type: 'webhook', config: '{}', currentStatus: 'up', alertConfirmedStatus: 'up', autoIncidentMinutes: 5,
      autoIncidentMode: 'published', autoIncidentTemplateId: template.id, createdAt: now, updatedAt: now,
    }).returning())[0]!
    await db.insert(layout).values({
      id: 1, updatedAt: now,
      tree: JSON.stringify({ id: 'root', type: 'page', children: [{ id: 'm', type: 'monitor', monitorId: monitor.id, showUptimeBar: true }] }),
    })
    await refreshPublishedMonitorIds()
    await recordObservation(monitor, down)
    await db.update(monitors).set({ failingSince: Date.now() - 6 * 60_000 }).where(eq(monitors.id, monitor.id))
    await recordObservation(await reload(monitor.id), down)
    return monitor
  }

  it('stores the wording of each installed language and shows it on the public page', async () => {
    await outage()
    const incident = (await db.select().from(incidents))[0]!
    assert.deepEqual(JSON.parse(incident.titleTranslations), { pl: 'API nie działa' })
    const [opening] = await db.select().from(incidentUpdates)
    assert.match(JSON.parse(opening!.bodyTranslations).pl, /^Awaria trwa \d+ min$/)

    const list = (await app.inject({ method: 'GET', url: '/public/incidents' })).json() as Array<{ title: string; titleTranslations: Record<string, string>; updates: Array<{ bodyTranslations: Record<string, string> }> }>
    assert.equal(list[0]!.title, 'API is down')
    assert.deepEqual(list[0]!.titleTranslations, { pl: 'API nie działa' })
    assert.ok(list[0]!.updates[0]!.bodyTranslations['pl'])
  })

  it('falls back to the template text for a field a language leaves empty, so the resolved update has no translation', async () => {
    const monitor = await outage()
    await recordObservation(await reload(monitor.id), up)
    const resolved = (await db.select().from(incidentUpdates)).find((u) => u.status === 'resolved')!
    assert.deepEqual(JSON.parse(resolved.bodyTranslations), {})
    assert.match(resolved.body, /^Back after/)
  })

  it('drops the translations of a title the operator rewrites', async () => {
    await outage()
    const incident = (await db.select().from(incidents))[0]!
    await app.inject({ method: 'PATCH', url: `/admin/incidents/${incident.id}`, payload: { title: incident.title } })
    assert.deepEqual(JSON.parse((await db.select().from(incidents))[0]!.titleTranslations), { pl: 'API nie działa' })
    const patched = (await app.inject({ method: 'PATCH', url: `/admin/incidents/${incident.id}`, payload: { title: 'Rewritten' } })).json()
    assert.deepEqual(patched.titleTranslations, {})
  })
})
