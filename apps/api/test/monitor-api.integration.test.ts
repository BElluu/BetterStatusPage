import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { auditLog, maintenanceWindows, monitors } from '../src/db/schema.js'
import { maintenanceRoutes } from '../src/routes/maintenance.js'
import { monitorRoutes } from '../src/routes/monitors.js'
import { SECRET_MASK } from '../src/services/secretFields.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-monitor-api-')
const app = Fastify({ logger: false })

before(async () => {
  initTestDb()
  app.addHook('preHandler', async (request) => {
    request.user = { userId: 1, email: 'admin@example.test', role: 'admin' }
  })
  await app.register(monitorRoutes, { prefix: '/monitors' })
  await app.register(maintenanceRoutes, { prefix: '/maintenance' })
  await app.ready()
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

const httpsBody = (patch: Record<string, unknown> = {}) => ({
  name: 'Site', type: 'https',
  config: { url: 'https://example.test', method: 'GET', expectedStatus: 200, headers: { Authorization: 'Bearer abc' }, auth: { type: 'basic', basic: { username: 'svc', password: 'p4ss' } } },
  ...patch,
})
const storedConfig = async (id: number) => JSON.parse((await db.select().from(monitors).where(eq(monitors.id, id)))[0]!.config)

describe('monitor secrets', () => {
  it('stores secrets as given but never returns them', async () => {
    const created = (await app.inject({ method: 'POST', url: '/monitors', payload: httpsBody() })).json()
    assert.equal(created.config.auth.basic.password, SECRET_MASK)
    assert.equal(created.config.auth.basic.username, 'svc')
    assert.equal(created.config.headers.Authorization, SECRET_MASK)
    assert.equal((await storedConfig(created.id)).auth.basic.password, 'p4ss')

    const one = (await app.inject({ url: `/monitors/${created.id}` })).json()
    assert.equal(one.config.auth.basic.password, SECRET_MASK)
    // Every response that carries a monitor is masked, not just the CRUD ones.
    const checked = (await app.inject({ method: 'POST', url: `/monitors/${created.id}/check-now` })).json()
    assert.equal(JSON.stringify(checked).includes('p4ss'), false)
    assert.equal(checked.config.auth.basic.password, SECRET_MASK)
    const listed = (await app.inject({ url: '/monitors' })).json().find((m: { id: number }) => m.id === created.id)
    assert.equal(listed.config.auth.basic.password, SECRET_MASK)
  })

  it('keeps a stored secret when the mask comes back, replaces it when a new one is sent', async () => {
    const created = (await app.inject({ method: 'POST', url: '/monitors', payload: httpsBody({ name: 'Keep' }) })).json()

    const kept = await app.inject({ method: 'PATCH', url: `/monitors/${created.id}`, payload: { config: { ...created.config, expectedStatus: 204 } } })
    assert.equal(kept.statusCode, 200)
    const afterKeep = await storedConfig(created.id)
    assert.equal(afterKeep.expectedStatus, 204)
    assert.equal(afterKeep.auth.basic.password, 'p4ss')
    assert.equal(afterKeep.headers.Authorization, 'Bearer abc')

    const replaced = structuredClone(created.config)
    replaced.auth.basic.password = 'new-pass'
    await app.inject({ method: 'PATCH', url: `/monitors/${created.id}`, payload: { config: replaced } })
    assert.equal((await storedConfig(created.id)).auth.basic.password, 'new-pass')
  })

  it('refuses a mask that is not the stored one, on create and update', async () => {
    const forged = httpsBody({ name: 'Forged' })
    forged.config.auth.basic.password = SECRET_MASK
    const create = await app.inject({ method: 'POST', url: '/monitors', payload: forged })
    assert.equal(create.statusCode, 400)
    assert.match(create.json().error, /auth\.basic\.password is a masked placeholder/)

    const created = (await app.inject({ method: 'POST', url: '/monitors', payload: httpsBody({ name: 'Forged update' }) })).json()
    const tampered = structuredClone(created.config)
    tampered.auth.basic.password = `${SECRET_MASK}x`
    assert.equal((await app.inject({ method: 'PATCH', url: `/monitors/${created.id}`, payload: { config: tampered } })).statusCode, 400)
    assert.equal((await storedConfig(created.id)).auth.basic.password, 'p4ss')
  })

  it('does not carry a stored secret over to another monitor type', async () => {
    const created = (await app.inject({ method: 'POST', url: '/monitors', payload: httpsBody({ name: 'Retyped' }) })).json()
    const retype = await app.inject({
      method: 'PATCH', url: `/monitors/${created.id}`,
      payload: { type: 'postgresql', config: { host: 'db', port: 5432, database: 'd', user: 'u', password: SECRET_MASK, query: 'select 1' } },
    })
    assert.equal(retype.statusCode, 400)
  })

  it('tests a form that still shows the mask against the stored secret, and refuses a stray mask', async () => {
    const created = (await app.inject({ method: 'POST', url: '/monitors', payload: httpsBody({ name: 'Tested' }) })).json()
    const stray = await app.inject({ method: 'POST', url: '/monitors/test', payload: { type: 'https', config: created.config } })
    assert.equal(stray.statusCode, 400)
    assert.match(stray.json().error, /masked placeholder/)
    const mismatch = await app.inject({ method: 'POST', url: '/monitors/test', payload: { type: 'https', monitorId: created.id, config: { ...created.config, auth: { type: 'basic', basic: { username: 'svc', password: `${SECRET_MASK}zz` } } } } })
    assert.equal(mismatch.statusCode, 400)
  })
})

describe('monitor input validation', () => {
  const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/monitors', payload })

  it('applies the defaults of the form', async () => {
    const created = (await post({ name: 'Defaults', type: 'webhook' })).json()
    assert.deepEqual(
      [created.intervalSecs, created.timeoutMs, created.retries, created.failureThreshold, created.recoveryThreshold, created.config, created.tags],
      [60, 10_000, 1, 1, 1, {}, []],
    )
  })

  it('rejects out-of-range schedule values, naming the limits', async () => {
    for (const [field, value, limit] of [['intervalSecs', 5, '10 to 86400'], ['intervalSecs', 1.5, '10 to 86400'], ['timeoutMs', 10, '1000 to 300000'], ['retries', 0, '1 to 10'], ['retries', '3', '1 to 10']] as const) {
      const response = await post({ name: 'X', type: 'webhook', [field]: value })
      assert.equal(response.statusCode, 400, `${field}=${value}`)
      assert.equal(response.json().error, `${field} must be a whole number from ${limit}`)
    }
  })

  it('rejects malformed names, configs and tags', async () => {
    assert.equal((await post({ type: 'webhook' })).json().error, 'Name is required')
    assert.equal((await post({ name: 'x'.repeat(201), type: 'webhook' })).statusCode, 400)
    assert.match((await post({ name: 'X', type: 'carrier-pigeon' })).json().error, /^Type must be one of/)
    assert.equal((await post({ name: 'X', type: 'https', config: [] })).json().error, 'config must be an object')
    assert.equal((await post({ name: 'X', type: 'https', config: 'url' })).json().error, 'config must be an object')
    assert.match((await post({ name: 'X', type: 'webhook', tags: [{ label: 'a' }] })).json().error, /^tags must be/)
    assert.equal((await post({ name: 'X', type: 'docker', config: {} })).statusCode, 400)
  })

  it('clamps thresholds instead of refusing them', async () => {
    const created = (await post({ name: 'Clamped', type: 'webhook', failureThreshold: 99, recoveryThreshold: 0 })).json()
    assert.deepEqual([created.failureThreshold, created.recoveryThreshold], [20, 1])
  })

  it('validates only the fields an update carries', async () => {
    const created = (await post({ name: 'Patched', type: 'webhook' })).json()
    assert.equal((await app.inject({ method: 'PATCH', url: `/monitors/${created.id}`, payload: { intervalSecs: 30 } })).json().intervalSecs, 30)
    assert.equal((await app.inject({ method: 'PATCH', url: `/monitors/${created.id}`, payload: { intervalSecs: 3 } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PATCH', url: `/monitors/${created.id}`, payload: { name: '  ' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PATCH', url: `/monitors/${created.id}`, payload: { tags: 'x' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PATCH', url: '/monitors/999999', payload: { intervalSecs: 3 } })).statusCode, 404)
  })
})

describe('maintenance input validation', () => {
  const window = { name: 'Upgrade', startsAt: 1_000, endsAt: 2_000 }
  const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/maintenance', payload })

  it('creates a window and dedupes its monitors', async () => {
    const monitorId = (await db.select().from(monitors))[0]!.id
    const created = await post({ ...window, monitorIds: [monitorId, monitorId], notifySubscribers: false })
    assert.equal(created.statusCode, 200)
    assert.deepEqual(created.json().monitorIds, [monitorId])
  })

  it('rejects missing or malformed fields', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ startsAt: 1_000, endsAt: 2_000 }, 'Name is required'],
      [{ ...window, startsAt: 'soon' }, 'startsAt must be a timestamp in milliseconds'],
      [{ ...window, endsAt: undefined }, 'endsAt must be a timestamp in milliseconds'],
      [{ ...window, endsAt: 1_000 }, 'endsAt must be after startsAt'],
      [{ ...window, description: 5 }, 'description must be text'],
      [{ ...window, monitorIds: 'all' }, 'monitorIds must be a list of monitor ids'],
      [{ ...window, monitorIds: [999_999] }, 'Unknown monitor'],
    ]
    for (const [payload, error] of cases) {
      const response = await post(payload)
      assert.equal(response.statusCode, 400, error)
      assert.equal(response.json().error, error)
    }
  })

  it('does not take a list of monitors too long for one statement', async () => {
    const response = await post({ ...window, monitorIds: Array.from({ length: 1_001 }, (_, i) => i + 1) })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error, 'monitorIds can name at most 1000 monitors')
  })

  it('checks a moved end against the stored start', async () => {
    const created = (await post({ ...window, notifySubscribers: false })).json()
    assert.equal((await app.inject({ method: 'PATCH', url: `/maintenance/${created.id}`, payload: { endsAt: 500 } })).json().error, 'endsAt must be after startsAt')
    assert.equal((await app.inject({ method: 'PATCH', url: `/maintenance/${created.id}`, payload: { endsAt: 3_000 } })).statusCode, 200)
    assert.equal((await db.select().from(maintenanceWindows).where(eq(maintenanceWindows.id, created.id)))[0]!.endsAt, 3_000)
  })
})

describe('resetting a heartbeat token', () => {
  it('is recorded in the audit log, without the token', async () => {
    const created = (await app.inject({ method: 'POST', url: '/monitors', payload: { name: 'Audited heartbeat', type: 'webhook', config: {} } })).json()
    const reset = await app.inject({ method: 'POST', url: `/monitors/${created.id}/reset-token` })
    assert.equal(reset.statusCode, 200)
    assert.notEqual(reset.json().webhookToken, created.webhookToken)

    const entry = (await db.select().from(auditLog).where(eq(auditLog.entityName, 'Audited heartbeat'))).find((e) => e.action === 'update')!
    assert.deepEqual(JSON.parse(entry.diff!), { action: 'heartbeat_token_reset' })
    assert.equal(JSON.stringify(entry).includes(reset.json().webhookToken), false)
  })
})
