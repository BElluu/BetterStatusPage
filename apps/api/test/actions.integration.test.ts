import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { actionNotificationChannels, actionRuns, actions, auditLog, maintenanceWindows, monitorActions, monitors, notificationChannels, notificationDeliveries, notificationDeliveryAttempts } from '../src/db/schema.js'
import { actionRoutes } from '../src/routes/actions.js'
import { notificationRoutes } from '../src/routes/notifications.js'
import { approveActionRun, cancelRunsOfMonitor, processDueActionRuns, purgeOldActionRuns, scheduleActionRuns } from '../src/workers/actionRunner.js'
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
    if (request.url === '/cancel-while-sending') {
      // The run is cancelled (the monitor recovered, say) while the request is on its way.
      void db.update(actionRuns).set({ status: 'cancelled' }).where(eq(actionRuns.status, 'pending')).then(() => response.writeHead(201).end())
      return
    }
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
    request.user = { userId: 1, email: 'admin@example.test', role: 'admin', ...(request.headers['x-test-token'] ? { apiToken: { id: 1, name: 'ci', scopes: ['actions:write'] } } : {}) }
  })
  await app.register(actionRoutes, { prefix: '/actions' })
  await app.ready()
})

beforeEach(async () => {
  requests.length = 0
  failuresRemaining = 0
  await db.delete(notificationDeliveryAttempts)
  await db.delete(notificationDeliveries)
  await db.delete(notificationChannels)
  await db.delete(actionNotificationChannels)
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

  it('gives an action a key from its name or the one asked for, and never changes it', async () => {
    const config = { url: 'https://host/', method: 'POST' }
    const first = await app.inject({ method: 'POST', url: '/actions', payload: { name: 'Start VM2', config } })
    const second = await app.inject({ method: 'POST', url: '/actions', payload: { name: 'Start VM2', config } })
    const chosen = await app.inject({ method: 'POST', url: '/actions', payload: { name: 'Other', key: 'my-key', config } })

    assert.deepEqual([first.json().key, second.json().key, chosen.json().key], ['start-vm2', 'start-vm2-2', 'my-key'])
    assert.equal((await app.inject({ method: 'POST', url: '/actions', payload: { name: 'Again', key: 'my-key', config } })).statusCode, 409)
    assert.equal((await app.inject({ method: 'POST', url: '/actions', payload: { name: 'Bad', key: 'Not A Key', config } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PATCH', url: `/actions/${first.json().id}`, payload: { key: 'renamed' } })).statusCode, 400)
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

  async function failedRun() {
    const monitor = await monitorRow()
    failuresRemaining = 10
    await linkedAction(monitor.id, { path: '/flaky' })
    await scheduleActionRuns(monitor, 'down', 'up', null)
    await settle()
    await processDueActionRuns(Date.now() + 2 * 60_000)
    await processDueActionRuns(Date.now() + 10 * 60_000)
    const [run] = await runsOf()
    assert.equal(run!.status, 'failed')
    return { monitor, run: run! }
  }

  it('retries a failed run by hand, with a fresh round of attempts', async () => {
    const { run } = await failedRun()
    failuresRemaining = 0

    const retried = await app.inject({ method: 'POST', url: `/actions/runs/${run.id}/retry` })

    assert.equal(retried.statusCode, 200)
    assert.equal(retried.json().status, 'succeeded')
    assert.equal(retried.json().attemptCount, 4)
    assert.equal(retried.json().maxAttempts, 6)
    assert.equal(retried.json().variables, undefined)
    assert.equal((await db.select().from(auditLog)).some((entry) => entry.entityType === 'action_run' && entry.action === 'update'), true)
  })

  it('refuses to retry a run that did not fail, and a second click', async () => {
    const monitor = await monitorRow()
    await linkedAction(monitor.id, { delayMinutes: 10 })
    await scheduleActionRuns(monitor, 'down', 'up', null)
    const [pending] = await runsOf()

    assert.equal((await app.inject({ method: 'POST', url: `/actions/runs/${pending!.id}/retry` })).statusCode, 409)
    assert.equal((await app.inject({ method: 'POST', url: '/actions/runs/9999/retry' })).statusCode, 404)
  })

  it('cancels a retried run whose monitor has recovered since', async () => {
    const { monitor, run } = await failedRun()
    await db.update(monitors).set({ alertConfirmedStatus: 'up' }).where(eq(monitors.id, monitor.id))

    const retried = await app.inject({ method: 'POST', url: `/actions/runs/${run.id}/retry` })

    assert.equal(retried.json().status, 'cancelled')
    assert.equal(retried.json().lastError, 'Monitor is no longer down')
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

describe('action failure notifications', () => {
  async function channel(type: string, config: Record<string, unknown>, enabled = 1) {
    const now = Date.now()
    return (await db.insert(notificationChannels).values({ name: `${type} ops`, type, config: JSON.stringify(config), enabled, createdAt: now, updatedAt: now }).returning())[0]!
  }

  async function failingAction(linked: number[]) {
    const monitor = await monitorRow()
    failuresRemaining = 10
    const action = await linkedAction(monitor.id, { path: '/flaky' })
    for (const channelId of linked) await db.insert(actionNotificationChannels).values({ actionId: action.id, channelId })
    await scheduleActionRuns(monitor, 'down', 'up', null)
    await settle()
    return { monitor, action }
  }

  const exhaust = async () => {
    await processDueActionRuns(Date.now() + 2 * 60_000)
    await processDueActionRuns(Date.now() + 10 * 60_000)
    await settle()
  }
  const notified = () => requests.filter((r) => r.url !== '/flaky')

  it('tells the chosen channels once, after the last attempt, without the request', async () => {
    const hook = await channel('webhook', { url: `${baseUrl}/notify`, method: 'POST', eventOverrides: { action: { body: '{"action":"{{action_name}}","status":"{{status}}","event":"{{event_type}}","error":"{{error_message}}","attempts":"{{attempts}}"}' } } })
    await failingAction([hook.id])
    assert.equal(notified().length, 0)

    await exhaust()

    assert.equal(notified().length, 1)
    assert.deepEqual(JSON.parse(notified()[0]!.body), { action: 'Start VM2', status: 'action-failed', event: 'action', error: 'HTTP 500', attempts: '3' })
    const [delivery] = await db.select().from(notificationDeliveries)
    assert.equal(delivery!.eventType, 'action')
    assert.equal(delivery!.monitorName, 'VM1 SQL cluster')
  })

  it('does not notify on success, for a cancelled run or through a disabled channel', async () => {
    const hook = await channel('webhook', { url: `${baseUrl}/notify`, method: 'POST' })
    const off = await channel('webhook', { url: `${baseUrl}/off`, method: 'POST' }, 0)

    const { monitor } = await failingAction([hook.id, off.id])
    failuresRemaining = 0
    await processDueActionRuns(Date.now() + 2 * 60_000)
    assert.equal(notified().length, 0)

    await db.delete(actionRuns)
    failuresRemaining = 10
    await scheduleActionRuns(monitor, 'down', 'up', null)
    await settle()
    await db.update(monitors).set({ alertConfirmedStatus: 'up' }).where(eq(monitors.id, monitor.id))
    await exhaust()
    assert.equal(notified().length, 0)

    await db.delete(actionRuns)
    await db.update(monitors).set({ alertConfirmedStatus: 'down' }).where(eq(monitors.id, monitor.id))
    await scheduleActionRuns(monitor, 'down', 'up', null)
    await settle()
    await exhaust()
    assert.deepEqual(notified().map((r) => r.url), ['/notify'])
  })

  it('tells the chosen channels about a success only when the channel is set to hear about it', async () => {
    const eventOverrides = { action: { body: '{"status":"{{status}}","error":"{{error_message}}","attempts":"{{attempts}}"}' } }
    const hears = await channel('webhook', { url: `${baseUrl}/notify`, method: 'POST', notifyOnActionSuccess: true, eventOverrides })
    const silent = await channel('webhook', { url: `${baseUrl}/silent`, method: 'POST', eventOverrides })
    await failingAction([hears.id, silent.id])
    failuresRemaining = 0

    await processDueActionRuns(Date.now() + 2 * 60_000)
    await settle()

    assert.deepEqual(notified().map((r) => r.url), ['/notify'])
    assert.deepEqual(JSON.parse(notified()[0]!.body), { status: 'action-succeeded', error: '', attempts: '2' })
  })

  it('sends an action in its default form when the channel has no wording for it, whatever its monitor wording says', async () => {
    const hook = await channel('webhook', { url: `${baseUrl}/notify`, method: 'POST', body: '{"monitor":"{{monitor_name}}"}' })
    await failingAction([hook.id])
    await exhaust()

    assert.deepEqual(JSON.parse(notified()[0]!.body), {
      action: 'Start VM2', monitor: 'VM1 SQL cluster', status: 'action-failed', trigger_status: 'down', attempts: '3', error: 'HTTP 500', time: JSON.parse(notified()[0]!.body).time,
    })
  })

  it('does not tell a channel about a run that was cancelled while it was sending, or through a disabled channel', async () => {
    const eventOverrides = { action: { body: '{"status":"{{status}}"}' } }
    const hears = await channel('webhook', { url: `${baseUrl}/notify`, method: 'POST', notifyOnActionSuccess: true, eventOverrides })
    const off = await channel('webhook', { url: `${baseUrl}/off`, method: 'POST', notifyOnActionSuccess: true, eventOverrides }, 0)
    const monitor = await monitorRow()
    const action = await linkedAction(monitor.id, { path: '/cancel-while-sending' })
    for (const channelId of [hears.id, off.id]) await db.insert(actionNotificationChannels).values({ actionId: action.id, channelId })
    await scheduleActionRuns(monitor, 'down', 'up', null)
    await settle()

    assert.equal((await db.select().from(actionRuns))[0]!.status, 'cancelled')
    const told = () => notified().map((r) => r.url).filter((url) => url === '/notify' || url === '/off')
    assert.deepEqual(told(), [])

    await db.delete(actionRuns)
    await db.update(actions).set({ config: JSON.stringify({ url: `${baseUrl}/ok`, method: 'POST' }) }).where(eq(actions.id, action.id))
    await scheduleActionRuns(monitor, 'down', 'up', null)
    await settle()
    // The channel that is disabled stays silent even though it is set to hear about successes.
    assert.deepEqual(told(), ['/notify'])
  })

  it('refuses both names of the channels at once, and a channel list that is null', async () => {
    const hook = await channel('webhook', { url: `${baseUrl}/notify`, method: 'POST' })
    const config = { url: 'https://host/', method: 'POST' }
    const both = await app.inject({ method: 'POST', url: '/actions', payload: { name: 'A', config, notificationChannelIds: [hook.id], failureChannelIds: [hook.id] } })
    assert.equal(both.statusCode, 400)
    assert.match(both.json().error, /old name/)
    const nothing = await app.inject({ method: 'POST', url: '/actions', payload: { name: 'A', config, notificationChannelIds: null } })
    assert.equal(nothing.statusCode, 400)
    const created = await app.inject({ method: 'POST', url: '/actions', payload: { name: 'A', config } })
    assert.equal((await app.inject({ method: 'PATCH', url: `/actions/${created.json().id}`, payload: { notificationChannelIds: [hook.id], failureChannelIds: [] } })).statusCode, 400)
  })

  it('words an action with the wording the channel has for actions', async () => {
    const hook = await channel('webhook', {
      url: `${baseUrl}/notify`, method: 'POST', body: '{"monitor":"{{monitor_name}}"}',
      eventOverrides: { action: { body: '{"action":"{{action_name}}","result":"{{status}}"}' } },
    })
    await failingAction([hook.id])
    await exhaust()

    assert.deepEqual(JSON.parse(notified()[0]!.body), { action: 'Start VM2', result: 'action-failed' })
  })

  it('words the failure for a Slack channel with the action and the monitor, not as a monitor status', async () => {
    const slack = await channel('slack', { webhookUrl: `${baseUrl}/slack` })
    await failingAction([slack.id])

    await exhaust()

    const payload = notified().find((r) => r.url === '/slack')!.body
    assert.match(payload, /Action \*Start VM2\* failed for monitor \*VM1 SQL cluster\*/)
    assert.match(payload, /Triggered when/)
    assert.doesNotMatch(payload, /Previous/)
  })

  it('chooses the channels through the API and drops them with the channel', async () => {
    const hook = await channel('webhook', { url: `${baseUrl}/notify`, method: 'POST' })
    const config = { url: 'https://host/', method: 'POST' }

    const created = await app.inject({ method: 'POST', url: '/actions', payload: { name: 'A', config, notificationChannelIds: [hook.id, hook.id] } })
    assert.equal(created.statusCode, 200)
    assert.deepEqual(created.json().notificationChannelIds, [hook.id])
    assert.deepEqual((await app.inject({ url: '/actions' })).json()[0].notificationChannelIds, [hook.id])

    const oldName = await app.inject({ method: 'PATCH', url: `/actions/${created.json().id}`, payload: { failureChannelIds: [] } })
    assert.deepEqual(oldName.json().notificationChannelIds, [], 'the name used up to 0.6 is still accepted')
    await app.inject({ method: 'PATCH', url: `/actions/${created.json().id}`, payload: { notificationChannelIds: [hook.id] } })
    assert.equal((await app.inject({ method: 'PATCH', url: `/actions/${created.json().id}`, payload: { notificationChannelIds: [9999] } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PATCH', url: `/actions/${created.json().id}`, payload: { notificationChannelIds: 'all' } })).statusCode, 400)
    const cleared = await app.inject({ method: 'PATCH', url: `/actions/${created.json().id}`, payload: { notificationChannelIds: [] } })
    assert.deepEqual(cleared.json().notificationChannelIds, [])

    await app.inject({ method: 'PATCH', url: `/actions/${created.json().id}`, payload: { notificationChannelIds: [hook.id] } })
    assert.equal((await app.inject({ method: 'DELETE', url: `/actions/${created.json().id}` })).statusCode, 204)
    assert.equal((await db.select().from(actionNotificationChannels)).length, 0)
  })

  it('keeps the failure out of the notification history of anyone who may not read actions', async () => {
    const hook = await channel('webhook', { url: `${baseUrl}/notify`, method: 'POST' })
    await failingAction([hook.id])
    await exhaust()
    const [delivery] = await db.select().from(notificationDeliveries)

    const history = async (role: string, url: string) => {
      const server = Fastify({ logger: false })
      server.addHook('preHandler', async (request) => { request.user = { userId: 1, email: 'caller@example.test', role } })
      await server.register(notificationRoutes, { prefix: '/notifications' })
      await server.ready()
      try { return await server.inject({ url }) } finally { await server.close() }
    }

    assert.equal((await history('admin', '/notifications/deliveries')).json().total, 1)
    assert.equal((await history('operator', '/notifications/deliveries')).json().total, 0)
    assert.equal((await history('admin', `/notifications/deliveries/${delivery!.id}`)).statusCode, 200)
    assert.equal((await history('operator', `/notifications/deliveries/${delivery!.id}`)).statusCode, 404)
  })
})
describe('actions that require approval', () => {
  const MINUTE = 60_000

  async function approvalAction(monitorId: number, link: { delayMinutes?: number; timeout?: number } = {}) {
    const action = await linkedAction(monitorId, link.delayMinutes === undefined ? {} : { delayMinutes: link.delayMinutes })
    await db.update(actions).set({ requiresApproval: 1, approvalTimeoutMinutes: link.timeout ?? 60 }).where(eq(actions.id, action.id))
    return action
  }
  const decide = (id: number, decision: 'approve' | 'reject', headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/actions/runs/${id}/${decision}`, headers })

  it('holds the run instead of sending it', async () => {
    const monitor = await monitorRow()
    await approvalAction(monitor.id)

    await scheduleActionRuns(monitor, 'down', 'up', null)
    await settle()

    assert.equal(requests.length, 0)
    const [run] = await runsOf()
    assert.equal(run!.status, 'awaiting_approval')
    assert.equal(run!.nextAttemptAt, run!.createdAt + 60 * MINUTE)
    assert.equal(await processDueActionRuns(Date.now() + 5 * MINUTE), 0)
    assert.equal(requests.length, 0)
  })

  it('sends the run once it is approved, and a second click changes nothing', async () => {
    const monitor = await monitorRow()
    await approvalAction(monitor.id)
    await scheduleActionRuns(monitor, 'down', 'up', null)
    const [waiting] = await runsOf()

    const approved = await decide(waiting!.id, 'approve')
    assert.equal(approved.statusCode, 200)
    await settle()

    assert.equal(requests.length, 1)
    assert.equal((await runsOf())[0]!.status, 'succeeded')
    assert.equal((await decide(waiting!.id, 'approve')).statusCode, 409)
    assert.equal((await decide(waiting!.id, 'reject')).statusCode, 409)
    const entries = await db.select().from(auditLog).where(eq(auditLog.entityType, 'action_run'))
    assert.ok(entries.some((entry) => entry.entityId === String(waiting!.id) && /approved/.test(entry.diff ?? '')))
  })

  it('counts the delay of the monitor from the approval', async () => {
    const monitor = await monitorRow()
    await approvalAction(monitor.id, { delayMinutes: 10 })
    await scheduleActionRuns(monitor, 'down', 'up', null)
    const [waiting] = await runsOf()

    const before = Date.now()
    assert.equal((await decide(waiting!.id, 'approve')).statusCode, 200)
    const [queued] = await runsOf()
    assert.equal(queued!.status, 'pending')
    assert.ok(queued!.nextAttemptAt! >= before + 10 * MINUTE)
    assert.equal(requests.length, 0)

    assert.equal(await processDueActionRuns(Date.now() + 11 * MINUTE), 1)
    assert.equal(requests.length, 1)
  })

  it('cancels a rejected run without sending it', async () => {
    const monitor = await monitorRow()
    await approvalAction(monitor.id)
    await scheduleActionRuns(monitor, 'down', 'up', null)
    const [waiting] = await runsOf()

    assert.equal((await decide(waiting!.id, 'reject')).statusCode, 200)
    await settle()

    const [run] = await runsOf()
    assert.equal(run!.status, 'cancelled')
    assert.equal(run!.lastError, 'Rejected by an admin')
    assert.equal(requests.length, 0)
  })

  it('cancels a run nobody approved in time, and refuses a late approval', async () => {
    const monitor = await monitorRow()
    await approvalAction(monitor.id, { timeout: 30 })
    await scheduleActionRuns(monitor, 'down', 'up', null)
    const [waiting] = await runsOf()

    await processDueActionRuns(Date.now() + 31 * MINUTE)

    const [run] = await runsOf()
    assert.equal(run!.status, 'cancelled')
    assert.equal(run!.lastError, 'Not approved in time')
    assert.equal((await decide(waiting!.id, 'approve')).statusCode, 409)
    assert.equal(requests.length, 0)
  })

  it('refuses a late approval even before the worker has cancelled the run', async () => {
    const monitor = await monitorRow()
    await approvalAction(monitor.id, { timeout: 30 })
    await scheduleActionRuns(monitor, 'down', 'up', null)
    const [waiting] = await runsOf()

    assert.equal(await approveActionRun(waiting!.id, Date.now() + 31 * MINUTE), false)
    assert.equal((await runsOf())[0]!.status, 'awaiting_approval')
  })

  it('drops a waiting run when the monitor recovers', async () => {
    const monitor = await monitorRow()
    await approvalAction(monitor.id)
    await scheduleActionRuns(monitor, 'down', 'up', null)

    await scheduleActionRuns(monitor, 'up', 'down', null)

    assert.equal((await runsOf())[0]!.status, 'cancelled')
  })

  it('still checks the monitor when the approval comes late', async () => {
    const monitor = await monitorRow()
    await approvalAction(monitor.id)
    await scheduleActionRuns(monitor, 'down', 'up', null)
    const [waiting] = await runsOf()
    await db.update(monitors).set({ alertConfirmedStatus: 'up' }).where(eq(monitors.id, monitor.id))

    assert.equal((await decide(waiting!.id, 'approve')).statusCode, 200)
    await settle()

    const [run] = await runsOf()
    assert.equal(run!.status, 'cancelled')
    assert.equal(requests.length, 0)
  })

  it('does not let an API token decide', async () => {
    const monitor = await monitorRow()
    await approvalAction(monitor.id)
    await scheduleActionRuns(monitor, 'down', 'up', null)
    const [waiting] = await runsOf()

    for (const decision of ['approve', 'reject'] as const) {
      const response = await decide(waiting!.id, decision, { 'x-test-token': '1' })
      assert.equal(response.statusCode, 403)
    }
    assert.equal((await runsOf())[0]!.status, 'awaiting_approval')
    assert.equal((await decide(9999, 'approve')).statusCode, 404)
  })

  it('tells the channels of the action that a run needs approval', async () => {
    const monitor = await monitorRow()
    const action = await approvalAction(monitor.id)
    const channel = (await db.insert(notificationChannels).values({
      name: 'Ops', type: 'webhook', config: JSON.stringify({ url: `${baseUrl}/hook`, method: 'POST' }), enabled: 1, createdAt: Date.now(), updatedAt: Date.now(),
    }).returning())[0]!
    await db.insert(actionNotificationChannels).values({ actionId: action.id, channelId: channel.id })

    await scheduleActionRuns(monitor, 'down', 'up', null)
    await settle()

    const [delivery] = await db.select().from(notificationDeliveries)
    assert.equal(JSON.parse(delivery!.variables)['status'], 'action-approval')
  })

  it('stores the setting from the API and rejects a bad timeout', async () => {
    const config = { url: `${baseUrl}/start`, method: 'POST' }
    const created = await app.inject({ method: 'POST', url: '/actions', payload: { name: 'A', config, requiresApproval: 1, approvalTimeoutMinutes: 15 } })
    assert.equal(created.statusCode, 200)
    assert.equal(created.json().requiresApproval, 1)
    assert.equal(created.json().approvalTimeoutMinutes, 15)

    const plain = await app.inject({ method: 'POST', url: '/actions', payload: { name: 'B', config } })
    assert.equal(plain.json().requiresApproval, 0)
    assert.equal(plain.json().approvalTimeoutMinutes, 60)

    const bad = await app.inject({ method: 'PATCH', url: `/actions/${created.json().id}`, payload: { approvalTimeoutMinutes: 0 } })
    assert.equal(bad.statusCode, 400)
    const off = await app.inject({ method: 'PATCH', url: `/actions/${created.json().id}`, payload: { requiresApproval: 0 } })
    assert.equal(off.json().requiresApproval, 0)
  })
})
