import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { actionRuns, actions, auditLog, maintenanceWindows, monitorActions, monitors } from '../src/db/schema.js'
import { actionRoutes } from '../src/routes/actions.js'
import { cancelRunsOfMonitor, processDueActionRuns, purgeOldActionRuns, scheduleActionRuns } from '../src/workers/actionRunner.js'
import { SECRET_MASK } from '../src/services/secretFields.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-actions-test-')
const requests: Array<{ url: string; method: string; body: string; authorization: string | undefined }> = []
let failuresRemaining = 0
const server = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    requests.push({ url: request.url ?? '', method: request.method ?? '', body: Buffer.concat(chunks).toString(), authorization: request.headers.authorization })
    if (request.url === '/flaky' && failuresRemaining-- > 0) {
      response.writeHead(500).end()
      return
    }
    response.writeHead(201).end()
  })
})
let baseUrl = ''
const app = Fastify({ logger: false })

before(async () => {
  initTestDb()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Action server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
  app.addHook('preHandler', async (request) => {
    request.user = { userId: 1, email: 'admin@example.test', role: 'admin' }
  })
  await app.register(actionRoutes, { prefix: '/actions' })
  await app.ready()
})

beforeEach(async () => {
  requests.length = 0
  failuresRemaining = 0
  await db.delete(actionRuns)
  await db.delete(maintenanceWindows)
  await db.delete(monitorActions)
  await db.delete(actions)
  await db.delete(monitors)
})

after(async () => {
  await app.close()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  teardownTestDb(testDb)
})

async function monitorRow(status = 'down') {
  const now = Date.now()
  return (await db.insert(monitors).values({
    name: 'VM1 SQL cluster', type: 'sqlserver', intervalSecs: 60, timeoutMs: 1_000, retries: 1,
    config: '{}', currentStatus: status, alertConfirmedStatus: status, tags: '[]', createdAt: now, updatedAt: now,
  }).returning())[0]!
}

async function linkedAction(monitorId: number, link: { onStatus?: string; delayMinutes?: number; cooldownMinutes?: number; path?: string; enabled?: number } = {}) {
  const now = Date.now()
  const action = (await db.insert(actions).values({
    name: 'Start VM2', enabled: link.enabled ?? 1, createdAt: now, updatedAt: now,
    config: JSON.stringify({ url: `${baseUrl}${link.path ?? '/start'}`, method: 'POST', headers: { Authorization: 'Basic abc' }, body: '{"monitor":"{{monitor_name}}","status":"{{status}}"}' }),
  }).returning())[0]!
  await db.insert(monitorActions).values({
    monitorId, actionId: action.id, onStatus: link.onStatus ?? 'down',
    delayMinutes: link.delayMinutes ?? 0, cooldownMinutes: link.cooldownMinutes ?? 0,
  })
  return action
}

const runsOf = () => db.select().from(actionRuns)
const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

describe('action runs', () => {
  it('sends a templated request at once when the action has no delay', async () => {
    const monitor = await monitorRow()
    await linkedAction(monitor.id)

    await scheduleActionRuns(monitor, 'down', 'up', 'connection refused')
    await settle()

    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.method, 'POST')
    assert.equal(requests[0]!.authorization, 'Basic abc')
    assert.deepEqual(JSON.parse(requests[0]!.body), { monitor: 'VM1 SQL cluster', status: 'down' })
    const [run] = await runsOf()
    assert.equal(run!.status, 'succeeded')
    assert.equal(run!.attemptCount, 1)
  })

  it('holds a delayed action until it is due', async () => {
    const monitor = await monitorRow()
    await linkedAction(monitor.id, { delayMinutes: 10 })

    await scheduleActionRuns(monitor, 'down', 'up', null)
    const [queued] = await runsOf()
    assert.equal(queued!.status, 'pending')
    assert.ok(queued!.nextAttemptAt! - queued!.createdAt >= 10 * 60_000)

    assert.equal(await processDueActionRuns(Date.now() + 5 * 60_000), 0)
    assert.equal(requests.length, 0)

    assert.equal(await processDueActionRuns(Date.now() + 11 * 60_000), 1)
    assert.equal(requests.length, 1)
    assert.equal((await runsOf())[0]!.status, 'succeeded')
  })

  it('cancels a waiting run when the monitor recovers first', async () => {
    const monitor = await monitorRow()
    await linkedAction(monitor.id, { delayMinutes: 10 })
    await scheduleActionRuns(monitor, 'down', 'up', null)

    await scheduleActionRuns(monitor, 'up', 'down', null)

    const [run] = await runsOf()
    assert.equal(run!.status, 'cancelled')
    assert.equal(await processDueActionRuns(Date.now() + 60 * 60_000), 0)
    assert.equal(requests.length, 0)
  })

  it('drops a due run whose monitor is no longer in the waited-for status', async () => {
    const monitor = await monitorRow()
    await linkedAction(monitor.id, { delayMinutes: 10 })
    await scheduleActionRuns(monitor, 'down', 'up', null)
    // The monitor recovered without the scheduler noticing (for example a restore or an import).
    await db.update(monitors).set({ alertConfirmedStatus: 'up' }).where(eq(monitors.id, monitor.id))

    await processDueActionRuns(Date.now() + 11 * 60_000)

    const [run] = await runsOf()
    assert.equal(run!.status, 'cancelled')
    assert.equal(requests.length, 0)
  })

  it('runs an up action only after an outage, not on a first successful check', async () => {
    const monitor = await monitorRow('up')
    await linkedAction(monitor.id, { onStatus: 'up', path: '/stop' })

    await scheduleActionRuns(monitor, 'up', 'pending', null)
    assert.equal((await runsOf()).length, 0)

    await scheduleActionRuns(monitor, 'up', 'down', null)
    await settle()
    assert.deepEqual(requests.map((r) => r.url), ['/stop'])
  })

  it('skips a second run inside the cooldown', async () => {
    const monitor = await monitorRow()
    await linkedAction(monitor.id, { cooldownMinutes: 30 })

    await scheduleActionRuns(monitor, 'down', 'up', null)
    await scheduleActionRuns(monitor, 'down', 'up', null)
    await settle()

    assert.equal((await runsOf()).length, 1)
    assert.equal(requests.length, 1)
  })

  it('ignores disabled actions', async () => {
    const monitor = await monitorRow()
    await linkedAction(monitor.id, { enabled: 0 })

    await scheduleActionRuns(monitor, 'down', 'up', null)

    assert.equal((await runsOf()).length, 0)
  })

  it('retries a failing request and gives up after three attempts', async () => {
    const monitor = await monitorRow()
    failuresRemaining = 10
    await linkedAction(monitor.id, { path: '/flaky' })

    await scheduleActionRuns(monitor, 'down', 'up', null)
    await settle()
    let [run] = await runsOf()
    assert.equal(run!.status, 'pending')
    assert.equal(run!.attemptCount, 1)
    assert.equal(run!.lastError, 'HTTP 500')

    await processDueActionRuns(Date.now() + 2 * 60_000)
    await processDueActionRuns(Date.now() + 10 * 60_000)
    ;[run] = await runsOf()
    assert.equal(run!.status, 'failed')
    assert.equal(run!.attemptCount, 3)
    assert.equal(requests.length, 3)
  })

  it('recovers when a retry succeeds', async () => {
    const monitor = await monitorRow()
    failuresRemaining = 1
    await linkedAction(monitor.id, { path: '/flaky' })

    await scheduleActionRuns(monitor, 'down', 'up', null)
    await settle()
    await processDueActionRuns(Date.now() + 2 * 60_000)

    const [run] = await runsOf()
    assert.equal(run!.status, 'succeeded')
    assert.equal(run!.attemptCount, 2)
  })

  it('cancels a due run while the monitor is in a maintenance window', async () => {
    const monitor = await monitorRow()
    await linkedAction(monitor.id, { delayMinutes: 10 })
    await scheduleActionRuns(monitor, 'down', 'up', null)
    const due = Date.now() + 11 * 60_000
    await db.insert(maintenanceWindows).values({ name: 'Fix VM1', startsAt: due - 60_000, endsAt: due + 60_000, createdAt: Date.now(), updatedAt: Date.now() })

    await processDueActionRuns(due)

    const [run] = await runsOf()
    assert.equal(run!.status, 'cancelled')
    assert.equal(run!.lastError, 'Monitor is in a maintenance window')
    assert.equal(requests.length, 0)
  })

  it('does not send, or bring back, a run whose link was removed', async () => {
    const monitor = await monitorRow()
    await linkedAction(monitor.id, { delayMinutes: 10 })
    await scheduleActionRuns(monitor, 'down', 'up', null)
    await db.delete(monitorActions)

    await processDueActionRuns(Date.now() + 11 * 60_000)

    const [run] = await runsOf()
    assert.equal(run!.status, 'cancelled')
    assert.equal(run!.lastError, 'Action is no longer linked to the monitor')
    assert.equal(requests.length, 0)
  })

  it('sends a run once when two workers pick it up together', async () => {
    const monitor = await monitorRow()
    await linkedAction(monitor.id, { delayMinutes: 10 })
    await scheduleActionRuns(monitor, 'down', 'up', null)
    const due = Date.now() + 11 * 60_000

    await Promise.all([processDueActionRuns(due), processDueActionRuns(due)])

    assert.equal(requests.length, 1)
  })

  it('cancels the queue of a deleted monitor and purges old finished runs', async () => {
    const monitor = await monitorRow()
    await linkedAction(monitor.id, { delayMinutes: 10 })
    await scheduleActionRuns(monitor, 'down', 'up', null)

    await cancelRunsOfMonitor(monitor.id)
    assert.equal((await runsOf())[0]!.status, 'cancelled')

    await purgeOldActionRuns(Date.now() + 200 * 24 * 60 * 60_000)
    assert.equal((await runsOf()).length, 0)
  })
})

describe('action API', () => {
  const create = (config: unknown, name = 'Start VM2') => app.inject({ method: 'POST', url: '/actions', payload: { name, config } })

  it('masks credential headers and keeps the stored value when the mask comes back', async () => {
    const created = await create({ url: 'https://jenkins.example.test/job/vm2/build', method: 'POST', headers: { Authorization: 'Basic secret', 'X-Note': 'plain' } })
    assert.equal(created.statusCode, 200)
    assert.equal(created.json().config.headers.Authorization, SECRET_MASK)
    assert.equal(created.json().config.headers['X-Note'], 'plain')
    const id = created.json().id

    const patched = await app.inject({ method: 'PATCH', url: `/actions/${id}`, payload: { name: 'Start VM2 (Jenkins)', config: created.json().config } })
    assert.equal(patched.statusCode, 200)
    const stored = JSON.parse((await db.select().from(actions).where(eq(actions.id, id)))[0]!.config)
    assert.equal(stored.headers.Authorization, 'Basic secret')
  })

  it('refuses to keep a stored secret when the URL changes', async () => {
    const created = await create({ url: 'https://jenkins.example.test/job/vm2/build', method: 'POST', headers: { Authorization: 'Basic secret' } })
    const patched = await app.inject({
      method: 'PATCH', url: `/actions/${created.json().id}`,
      payload: { config: { ...created.json().config, url: 'https://elsewhere.example.test/' } },
    })
    assert.equal(patched.statusCode, 400)
  })

  it('validates the configuration', async () => {
    assert.equal((await create({ url: 'ftp://host/', method: 'POST' })).statusCode, 400)
    assert.equal((await create({ url: 'https://host/', method: 'DELETE' })).statusCode, 400)
    assert.equal((await create({ url: 'https://host/', method: 'POST', headers: { A: 1 } })).statusCode, 400)
    assert.equal((await create({ url: 'https://host/', method: 'GET', body: '{}' })).statusCode, 400)
    assert.equal((await create({ url: 'https://host/', method: 'POST', body: 'status={{status}}' })).statusCode, 400)
    assert.equal((await create({ url: 'https://host/', method: 'POST', body: '{"status":"{{status}}"}' }, 'Json body')).statusCode, 200)
    assert.equal((await app.inject({ method: 'POST', url: '/actions', payload: { name: 'x', enabled: true, config: { url: 'https://host/', method: 'POST' } } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: '/actions', payload: { name: 'x'.repeat(201), config: { url: 'https://host/', method: 'POST' } } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: '/actions', payload: { name: ' ', config: {} } })).statusCode, 400)
  })

  it('sends the real request from the test route and reports a failure', async () => {
    const ok = await create({ url: `${baseUrl}/start`, method: 'POST' })
    assert.equal((await app.inject({ method: 'POST', url: `/actions/${ok.json().id}/test` })).statusCode, 200)
    assert.equal(requests.length, 1)

    failuresRemaining = 1
    const bad = await create({ url: `${baseUrl}/flaky`, method: 'POST' }, 'Flaky')
    const result = await app.inject({ method: 'POST', url: `/actions/${bad.json().id}/test` })
    assert.equal(result.statusCode, 422)
  })

  it('replaces the links of a monitor and rejects invalid ones', async () => {
    const monitor = await monitorRow('up')
    const action = (await create({ url: 'https://host/', method: 'POST' })).json()
    const put = (links: unknown) => app.inject({ method: 'PUT', url: `/actions/monitor/${monitor.id}`, payload: { actions: links } })

    assert.equal((await put([{ actionId: action.id, onStatus: 'down', delayMinutes: 5, cooldownMinutes: 60 }, { actionId: action.id, onStatus: 'up' }])).statusCode, 200)
    const links = (await app.inject({ url: `/actions/monitor/${monitor.id}` })).json()
    assert.equal(links.length, 2)
    assert.deepEqual(links.find((l: { onStatus: string }) => l.onStatus === 'down'), { actionId: action.id, onStatus: 'down', delayMinutes: 5, cooldownMinutes: 60 })

    assert.equal((await put([{ actionId: action.id, onStatus: 'sideways' }])).statusCode, 400)
    assert.equal((await put([{ actionId: action.id, onStatus: 'down', delayMinutes: -1 }])).statusCode, 400)
    assert.equal((await put([{ actionId: action.id, onStatus: 'down' }, { actionId: action.id, onStatus: 'down' }])).statusCode, 400)
    assert.equal((await put([{ actionId: 9999, onStatus: 'down' }])).statusCode, 400)
    assert.equal((await app.inject({ method: 'PUT', url: '/actions/monitor/9999', payload: { actions: [] } })).statusCode, 404)
    assert.equal((await app.inject({ url: `/actions/monitor/${monitor.id}` })).json().length, 2)
  })

  it('cancels a queued run when its link is removed', async () => {
    const monitor = await monitorRow()
    const action = await linkedAction(monitor.id, { delayMinutes: 10 })
    await scheduleActionRuns(monitor, 'down', 'up', null)

    await app.inject({ method: 'PUT', url: `/actions/monitor/${monitor.id}`, payload: { actions: [] } })

    assert.equal((await runsOf())[0]!.status, 'cancelled')
    assert.equal((await db.select().from(monitorActions).where(eq(monitorActions.actionId, action.id))).length, 0)
  })

  it('deleting an action removes its links, cancels its queue and keeps the history', async () => {
    const monitor = await monitorRow()
    const action = await linkedAction(monitor.id, { delayMinutes: 10 })
    await scheduleActionRuns(monitor, 'down', 'up', null)

    assert.equal((await app.inject({ method: 'DELETE', url: `/actions/${action.id}` })).statusCode, 204)

    assert.equal((await db.select().from(monitorActions)).length, 0)
    const [run] = await runsOf()
    assert.equal(run!.status, 'cancelled')
    assert.equal(run!.actionName, 'Start VM2')
    assert.equal((await db.select().from(auditLog)).some((entry) => entry.entityType === 'action' && entry.action === 'delete'), true)
  })

  it('lists runs with filters and pagination', async () => {
    const monitor = await monitorRow()
    await linkedAction(monitor.id, { delayMinutes: 10 })
    await scheduleActionRuns(monitor, 'down', 'up', null)

    const all = (await app.inject({ url: '/actions/runs' })).json()
    assert.equal(all.total, 1)
    assert.equal(all.runs[0].status, 'pending')
    assert.equal((await app.inject({ url: '/actions/runs?status=failed' })).json().total, 0)
    assert.equal((await app.inject({ url: `/actions/runs?monitorId=${monitor.id}` })).json().total, 1)
  })
})
