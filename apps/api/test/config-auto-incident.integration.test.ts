import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { sqlite } from '../src/db/client.js'
import { configRoutes } from '../src/kit/configRoutes.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-config-auto-incident-')
const app = Fastify({ logger: false })

before(async () => {
  initTestDb()
  app.addHook('onRequest', async (request) => {
    request.user = { userId: 1, email: 'admin@example.test', role: 'admin', sessionId: 'test-session' }
  })
  await app.register(configRoutes, { prefix: '/config' })
  await app.ready()
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM monitor_notification_channels; DELETE FROM monitor_dependencies; DELETE FROM monitors;
    DELETE FROM notification_channels; DELETE FROM audit_log;
    DELETE FROM incident_templates WHERE is_default = 0;
  `)
})

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const apply = (doc: unknown) => app.inject({
  method: 'POST', url: '/config/apply',
  headers: { authorization: 'Bearer test', 'content-type': 'application/yaml' },
  payload: JSON.stringify(doc),
})
const monitor = (patch: Doc = {}): Doc => ({ kind: 'Monitor', key: 'site', name: 'Site', type: 'https', config: { url: 'https://example.test', method: 'GET', expectedStatus: 200 }, ...patch })
const stored = () => ({ ...sqlite.prepare('SELECT auto_incident_minutes AS minutes, auto_incident_mode AS mode, auto_incident_template_id AS templateId FROM monitors WHERE key = ?').get('site') as
  { minutes: number | null; mode: string; templateId: number | null } })
const addTemplate = (name: string) => Number(sqlite.prepare(
  'INSERT INTO incident_templates (name, title, body, resolved_body, impact, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 1, 1)',
).run(name, 't', 'b', 'r', 'major').lastInsertRowid)
const exported = async () => (await app.inject({ method: 'GET', url: '/config/export?kind=Monitor&key=site', headers: { authorization: 'Bearer test' } })).body

describe('automatic incidents in configuration files', () => {
  it('is off when the block is missing or disabled', async () => {
    assert.equal((await apply(monitor())).statusCode, 200)
    assert.equal(stored().minutes, null)
    assert.equal((await apply(monitor({ autoIncident: { enabled: false, afterMinutes: 5 } }))).statusCode, 200)
    assert.equal(stored().minutes, null)
    assert.doesNotMatch(await exported(), /autoIncident/)
  })

  it('turns on with the default template and draft mode when only the minutes are given', async () => {
    assert.equal((await apply(monitor({ autoIncident: { afterMinutes: 10 } }))).statusCode, 200)
    assert.deepEqual(stored(), { minutes: 10, mode: 'draft', templateId: null })
    const text = await exported()
    assert.match(text, /afterMinutes: 10/)
    assert.doesNotMatch(text, /template/)
  })

  it('uses a template by name, and turns off again when the block is removed', async () => {
    const id = addTemplate('Payments')
    assert.equal((await apply(monitor({ autoIncident: { afterMinutes: 3, mode: 'published', template: 'Payments' } }))).statusCode, 200)
    assert.deepEqual(stored(), { minutes: 3, mode: 'published', templateId: id })
    assert.match(await exported(), /template: Payments/)

    const unchanged = await apply(monitor({ autoIncident: { afterMinutes: 3, mode: 'published', template: 'Payments' } }))
    assert.equal(unchanged.json().summary.unchanged, 1)

    assert.equal((await apply(monitor())).statusCode, 200)
    assert.deepEqual(stored(), { minutes: null, mode: 'draft', templateId: null })
  })

  it('treats naming the default template as no template', async () => {
    const name = (sqlite.prepare('SELECT name FROM incident_templates WHERE is_default = 1').get() as { name: string }).name
    assert.equal((await apply(monitor({ autoIncident: { afterMinutes: 5, template: name } }))).statusCode, 200)
    assert.equal(stored().templateId, null)
  })

  it('refuses an unknown template, a bad mode, missing or out-of-range minutes and unknown settings', async () => {
    const problems = async (autoIncident: unknown) => {
      const response = await apply(monitor({ autoIncident }))
      assert.equal(response.statusCode, 400, response.body)
      return Object.fromEntries((response.json().problems as Array<{ path: string; message: string }>).map((p) => [p.path, p.message]))
    }
    assert.match((await problems({ afterMinutes: 5, template: 'Nope' }))['Monitor[site].autoIncident.template']!, /unknown incident template/)
    assert.ok((await problems({ afterMinutes: 5, mode: 'public' }))['Monitor[site].autoIncident.mode'])
    assert.ok((await problems({ mode: 'draft' }))['Monitor[site].autoIncident.afterMinutes'])
    assert.ok((await problems({ afterMinutes: 0 }))['Monitor[site].autoIncident.afterMinutes'])
    assert.ok((await problems({ afterMinutes: 5, minutes: 5 }))['Monitor[site].autoIncident.minutes'])
    assert.ok((await problems('yes'))['Monitor[site].autoIncident'])
  })
})
