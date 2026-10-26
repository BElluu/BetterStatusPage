import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { sqlite } from '../src/db/client.js'
import { configRoutes } from '../src/kit/configRoutes.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-config-latency-alert-')
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
  `)
})

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const apply = (doc: unknown) => app.inject({
  method: 'POST', url: '/config/apply',
  headers: { authorization: 'Bearer test', 'content-type': 'application/yaml' },
  payload: JSON.stringify(doc),
})
const monitor = (patch: Doc = {}): Doc => ({ kind: 'Monitor', key: 'site', name: 'Site', type: 'https', config: { url: 'https://example.test', method: 'GET', expectedStatus: 200 }, ...patch })
const stored = () => ({ ...sqlite.prepare(
  'SELECT latency_alert_factor AS factor, latency_alert_window_minutes AS windowMinutes, latency_alert_min_delta_ms AS minDeltaMs, latency_alert_sustain AS sustain FROM monitors WHERE key = ?',
).get('site') as { factor: number | null; windowMinutes: number; minDeltaMs: number; sustain: number } })
const exported = async () => (await app.inject({ method: 'GET', url: '/config/export?kind=Monitor&key=site', headers: { authorization: 'Bearer test' } })).body

describe('slower-than-usual alert in configuration files', () => {
  it('is off when the block is missing or disabled', async () => {
    assert.equal((await apply(monitor())).statusCode, 200)
    assert.equal(stored().factor, null)
    assert.equal((await apply(monitor({ latencyAlert: { enabled: false, factor: 4 } }))).statusCode, 200)
    assert.equal(stored().factor, null)
    assert.doesNotMatch(await exported(), /latencyAlert/)
  })

  it('turns on with the defaults when the block is empty', async () => {
    assert.equal((await apply(monitor({ latencyAlert: {} }))).statusCode, 200)
    assert.deepEqual(stored(), { factor: 3, windowMinutes: 30, minDeltaMs: 200, sustain: 3 })
    assert.match(await exported(), /latencyAlert:/)
  })

  it('stores the settings, sees an identical file as unchanged, and turns off when the block is removed', async () => {
    const block = { factor: 2.5, windowMinutes: 60, minDeltaMs: 100, sustain: 5 }
    assert.equal((await apply(monitor({ latencyAlert: block }))).statusCode, 200)
    assert.deepEqual(stored(), block)
    const text = await exported()
    assert.match(text, /factor: 2.5/)
    assert.match(text, /windowMinutes: 60/)

    assert.equal((await apply(monitor({ latencyAlert: block }))).json().summary.unchanged, 1)

    assert.equal((await apply(monitor())).statusCode, 200)
    assert.equal(stored().factor, null)
  })

  it('closes an open alert when the settings change, and leaves it alone otherwise', async () => {
    const block = { factor: 3 }
    await apply(monitor({ latencyAlert: block }))
    sqlite.prepare('UPDATE monitors SET latency_alert_since = 5, latency_alert_count = 1, latency_baseline_at = 7 WHERE key = ?').run('site')
    await apply(monitor({ name: 'Renamed', latencyAlert: block }))
    const open = sqlite.prepare('SELECT latency_alert_since AS since, latency_baseline_at AS at FROM monitors WHERE key = ?').get('site') as { since: number | null; at: number | null }
    assert.deepEqual({ ...open }, { since: 5, at: 7 })

    await apply(monitor({ name: 'Renamed', latencyAlert: { factor: 4 } }))
    const closed = sqlite.prepare('SELECT latency_alert_since AS since, latency_alert_count AS count, latency_baseline_at AS at FROM monitors WHERE key = ?').get('site') as { since: number | null; count: number; at: number | null }
    assert.deepEqual({ ...closed }, { since: null, count: 0, at: null })
  })

  it('refuses the alert for a type whose response time is not the time a service took to answer', async () => {
    const response = await apply(monitor({ type: 'domain', config: { domain: 'example.com', warnDays: 30 }, latencyAlert: {} }))
    assert.equal(response.statusCode, 400, response.body)
    assert.match((response.json().problems as Array<{ path: string; message: string }>)[0]!.message, /not available for domain/)
    assert.equal((await apply(monitor({ type: 'domain', config: { domain: 'example.com', warnDays: 30 }, latencyAlert: { enabled: false } }))).statusCode, 200)
  })

  it('refuses settings out of range, unknown fields and a block that is not an object', async () => {
    const problems = async (latencyAlert: unknown) => {
      const response = await apply(monitor({ latencyAlert }))
      assert.equal(response.statusCode, 400, response.body)
      return Object.fromEntries((response.json().problems as Array<{ path: string; message: string }>).map((p) => [p.path, p.message]))
    }
    assert.ok((await problems({ factor: 1 }))['Monitor[site].latencyAlert.factor'])
    assert.ok((await problems({ factor: 11 }))['Monitor[site].latencyAlert.factor'])
    assert.ok((await problems({ factor: '3' }))['Monitor[site].latencyAlert.factor'])
    assert.ok((await problems({ windowMinutes: 5 }))['Monitor[site].latencyAlert.windowMinutes'])
    assert.ok((await problems({ minDeltaMs: -1 }))['Monitor[site].latencyAlert.minDeltaMs'])
    assert.ok((await problems({ sustain: 0 }))['Monitor[site].latencyAlert.sustain'])
    assert.ok((await problems({ sustain: 2.5 }))['Monitor[site].latencyAlert.sustain'])
    assert.ok((await problems({ minutes: 5 }))['Monitor[site].latencyAlert.minutes'])
    assert.ok((await problems({ enabled: 'yes' }))['Monitor[site].latencyAlert.enabled'])
    assert.ok((await problems('yes'))['Monitor[site].latencyAlert'])
  })
})
