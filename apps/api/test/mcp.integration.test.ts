import assert from 'node:assert/strict'

process.env['UPDATE_CHECK'] = 'false'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify, { type RouteOptions } from 'fastify'
import bcrypt from 'bcryptjs'
import jwt from '@fastify/jwt'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import { TOKEN_RESOURCES } from '@bsp/shared'
import { adminApi } from '../src/adminApi.js'
import { MONITOR_SETTINGS } from '../src/mcp/monitorFields.js'
import { MONITOR_CONFIG_SCHEMAS } from '../src/services/monitorConfigSchema.js'
import { MONITOR_TYPES } from '../src/services/monitorInput.js'
import { MCP_INSTRUCTIONS } from '../src/mcp/tools.js'
import { db } from '../src/db/client.js'
import { auditLog, authSessions, incidents, maintenanceWindows, mcpSettings, monitorDependencies, monitors, notificationChannels, subscribers, users } from '../src/db/schema.js'
import { auth } from '../src/kit/auth.js'
import { registerMcp } from '../src/mcp/register.js'
import { createProductionFallback } from '../src/services/productionFallback.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const PASSWORD = 'admin-password'
const testDb = createTestDb('bsp-mcp-')
process.env['UPLOAD_DIR'] = join(testDb.dir, 'uploads')
const app = Fastify({ logger: false })
let admin: { authorization: string }
const sessionOf: Record<string, { authorization: string }> = {}
const routeOptions: RouteOptions[] = []

before(async () => {
  initTestDb()
  app.addHook('onRoute', (route) => { routeOptions.push(route) })
  await app.register(cookie)
  await app.register(jwt, { secret: 'test-secret-with-sufficient-entropy' })
  await app.register(multipart)
  await app.register(adminApi, { prefix: '/api/v1/admin' })
  registerMcp(app)
  await app.ready()
  await setMcp(true, true)

  const now = Date.now()
  const [user] = await db.insert(users).values({ email: 'admin@example.test', passwordHash: await bcrypt.hash(PASSWORD, 4), role: 'admin', createdAt: now }).returning()
  await db.insert(authSessions).values({ id: 'session-admin', userId: user!.id, csrfTokenHash: 'unused', createdAt: now, lastSeenAt: now, expiresAt: now + 60_000 })
  admin = { authorization: `Bearer ${app.jwt.sign({ userId: user!.id, email: user!.email, role: 'admin', sessionId: 'session-admin' })}` }
  for (const role of ['operator', 'branding'] as const) {
    const [other] = await db.insert(users).values({ email: `${role}@example.test`, passwordHash: 'unused', role, createdAt: now }).returning()
    await db.insert(authSessions).values({ id: `session-${role}`, userId: other!.id, csrfTokenHash: 'unused', createdAt: now, lastSeenAt: now, expiresAt: now + 60_000 })
    sessionOf[role] = { authorization: `Bearer ${app.jwt.sign({ userId: other!.id, email: other!.email, role, sessionId: `session-${role}` })}` }
  }
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

beforeEach(() => {
  auth.apiTokens.resetApiTokenBudgets()
  delete process.env['PUBLIC_URL']
})

async function setMcp(enabled: boolean, allowChanges: boolean) {
  const values = { enabled: enabled ? 1 : 0, allowChanges: allowChanges ? 1 : 0, updatedAt: Date.now() }
  await db.insert(mcpSettings).values({ id: 1, ...values }).onConflictDoUpdate({ target: mcpSettings.id, set: values })
}

async function tokenWith(...scopes: string[]): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/v1/admin/api-tokens', headers: admin, payload: { name: 'Agent', scopes, currentPassword: PASSWORD } })
  return (response.json() as { token: string }).token
}

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }

function rpc(token: string | null, method: string, params?: unknown, headers: Record<string, string> = {}) {
  const bearer: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}
  return app.inject({
    method: 'POST', url: '/mcp',
    headers: { ...MCP_HEADERS, ...bearer, ...headers },
    payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
  })
}

interface ToolResult { isError?: boolean; content: Array<{ text: string }> }
async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await rpc(token, 'tools/call', { name, arguments: args })
  assert.equal(response.statusCode, 200, response.body)
  const result = (response.json() as { result?: ToolResult; error?: { message: string } })
  return result.result ?? { isError: true, content: [{ text: result.error?.message ?? '' }] }
}
const parsed = (result: ToolResult) => JSON.parse(result.content[0]!.text) as Record<string, unknown>

async function toolNames(token: string): Promise<string[]> {
  const response = await rpc(token, 'tools/list')
  return (response.json() as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)
}

async function createMonitor(payload: Record<string, unknown>) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/admin/monitors', headers: admin, payload })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as { id: number; webhookToken: string | null }
}

describe('who may use the endpoint', () => {
  it('needs an API token in a Bearer header', async () => {
    const attempts: Array<Record<string, string>> = [{}, { authorization: 'Bearer nope' }, { authorization: 'Basic abc' }, { authorization: admin.authorization }]
    for (const headers of attempts) {
      const response = await rpc(null, 'tools/list', undefined, headers)
      assert.equal(response.statusCode, 401, JSON.stringify(headers))
      assert.match(String(response.headers['www-authenticate']), /^Bearer/)
    }
  })

  it('does not look at the session cookie', async () => {
    const session = admin.authorization.slice(7)
    const response = await rpc(null, 'tools/list', undefined, { cookie: `bsp_session=${session}` })
    assert.equal(response.statusCode, 401)
  })

  it('refuses a token that was revoked or has expired', async () => {
    const token = await tokenWith('monitors:read')
    const list = (await app.inject({ url: '/api/v1/admin/api-tokens', headers: admin })).json() as Array<{ id: number }>
    for (const each of list) await app.inject({ method: 'DELETE', url: `/api/v1/admin/api-tokens/${each.id}`, headers: admin })
    assert.equal((await rpc(token, 'tools/list')).statusCode, 401)
  })

  it('refuses a request from a web page, and one for another host when the public URL is known', async () => {
    const token = await tokenWith('monitors:read')
    assert.equal((await rpc(token, 'tools/list', undefined, { origin: 'https://evil.example' })).statusCode, 403)
    assert.equal((await rpc(token, 'tools/list')).statusCode, 200)

    process.env['PUBLIC_URL'] = 'https://status.example.com'
    assert.equal((await rpc(token, 'tools/list', undefined, { host: 'status.example.com' })).statusCode, 200)
    assert.equal((await rpc(token, 'tools/list', undefined, { host: 'status.example.com', origin: 'https://status.example.com' })).statusCode, 200)
    assert.equal((await rpc(token, 'tools/list', undefined, { host: 'rebind.evil.example' })).statusCode, 403)
    assert.equal((await rpc(token, 'tools/list', undefined, { host: 'status.example.com', origin: 'https://evil.example' })).statusCode, 403)
  })

  it('answers GET and DELETE with 405', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const response = await app.inject({ method, url: '/mcp' })
      assert.equal(response.statusCode, 405)
      assert.equal(response.headers['allow'], 'POST')
    }
  })
})

describe('which tools a token sees', () => {
  it('lists only the tools its permissions allow, all of them read-only', async () => {
    const monitorsOnly = await toolNames(await tokenWith('monitors:read'))
    assert.deepEqual(monitorsOnly.sort(), ['get_monitor', 'list_monitors', 'monitor_config_fields', 'monitor_dependencies', 'monitor_results', 'monitor_stats', 'status_overview'])

    const everything = await tokenWith('monitors:read', 'incidents:read', 'maintenance:read', 'channels:read', 'reports:read', 'audit:read', 'system:read')
    const names = await toolNames(everything)
    assert.equal(names.length, 17, names.join())
    const listed = ((await rpc(everything, 'tools/list')).json() as { result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> } }).result.tools
    assert.ok(listed.every((tool) => tool.annotations['readOnlyHint'] === true), 'a read-only token is offered a tool that changes data')

    const response = await rpc(everything, 'tools/list')
    const tools = (response.json() as { result: { tools: Array<{ annotations: Record<string, boolean> }> } }).result.tools
    assert.ok(tools.every((tool) => tool.annotations['readOnlyHint'] === true && tool.annotations['destructiveHint'] === false))
  })

  it('does not run a tool the token cannot see', async () => {
    const response = await rpc(await tokenWith('monitors:read'), 'tools/call', { name: 'audit_log', arguments: {} })
    const body = response.json() as { result?: { isError?: boolean; content: Array<{ text: string }> }; error?: { message: string } }
    // Refused by the MCP layer as an unknown tool, before any request to the admin API.
    assert.match(body.error?.message ?? body.result?.content[0]?.text ?? '', /not found/i)
  })
})

describe('what the tools return', () => {
  it('summarises the monitors and answers with the admin API behind it', async () => {
    const created = await createMonitor({ name: 'Landing', type: 'https', config: { url: 'https://example.test' } })
    const token = await tokenWith('monitors:read')

    const overview = parsed(await call(token, 'status_overview'))
    assert.equal(overview['monitors'], 1)
    assert.ok(!('openIncidents' in overview), 'no incident permission, no incidents')

    const listed = parsed(await call(token, 'list_monitors', { limit: 10 })) as { total: number; items: Array<{ id: number; name: string }> }
    assert.equal(listed.total, 1)
    assert.equal(listed.items[0]!.id, created.id)
    assert.equal(parsed(await call(token, 'list_monitors', { status: 'down' }))['total'], 0)

    const stats = parsed(await call(token, 'monitor_stats', { id: created.id }))
    assert.equal(stats['monitorId'], created.id)
    assert.ok(!('buckets' in stats))
  })

  it('answers every tool for a token that holds the permissions', async () => {
    const created = await createMonitor({ name: 'Checked', type: 'https', config: { url: 'https://checked.example.test' } })
    const token = await tokenWith('monitors:read', 'incidents:read', 'maintenance:read', 'channels:read', 'reports:read', 'audit:read', 'system:read')
    const overview = parsed(await call(token, 'status_overview'))
    assert.ok(Array.isArray(overview['openIncidents']) && 'activeMaintenance' in overview)
    const calls: Array<[string, Record<string, unknown>]> = [
      ['monitor_results', { id: created.id }], ['uptime_report', {}], ['list_incidents', {}], ['list_maintenance', {}],
      ['list_notification_deliveries', {}], ['audit_log', {}], ['system_health', {}],
    ]
    for (const [name, args] of calls) {
      const result = await call(token, name, args)
      assert.ok(!result.isError, `${name}: ${result.content[0]!.text}`)
    }
    const results = parsed(await call(token, 'monitor_results', { id: created.id })) as { scanned: number; capped: boolean }
    assert.equal(typeof results.scanned, 'number')
    assert.equal(results.capped, false)
    assert.equal(parsed(await call(token, 'audit_log', { entityType: 'monitor' }))['total'] !== undefined, true)
  })

  it('passes on a refusal from the admin API instead of a result', async () => {
    const result = await call(await tokenWith('monitors:read'), 'get_monitor', { id: 99999 })
    assert.equal(result.isError, true)
    assert.match(result.content[0]!.text, /404/)
  })

  it('never shows the heartbeat token, even to a token that may write monitors', async () => {
    const heartbeat = await createMonitor({ name: 'Nightly job', type: 'webhook', config: {} })
    assert.ok(heartbeat.webhookToken)
    for (const scope of ['monitors:read', 'monitors:write']) {
      const token = await tokenWith(scope)
      const one = await call(token, 'get_monitor', { id: heartbeat.id })
      assert.ok(!one.content[0]!.text.includes(heartbeat.webhookToken!), scope)
      const all = await call(token, 'list_monitors')
      assert.ok(!all.content[0]!.text.includes(heartbeat.webhookToken!), scope)
    }
  })

  it('keeps the passwords of service monitors masked', async () => {
    const redis = await createMonitor({ name: 'Cache', type: 'redis', config: { host: 'cache.example.test', port: 6379, username: 'alice', password: 'redis-secret-value' } })
    const token = await tokenWith('monitors:read')
    for (const [tool, args] of [['get_monitor', { id: redis.id }], ['list_monitors', {}], ['status_overview', {}]] as const) {
      const text = (await call(token, tool, args)).content[0]!.text
      assert.ok(!text.includes('redis-secret-value'), tool)
    }
    assert.match((await call(token, 'get_monitor', { id: redis.id })).content[0]!.text, /Cache/)
  })

  it('hands text from outside over as plain, bounded data', async () => {
    const hidden = [27, 0x202e, 0x200b].map((code) => String.fromCharCode(code))
    const [escape, override, zeroWidth] = hidden as [string, string, string]
    await createMonitor({ name: `Odd ${escape}[31mred${escape}[0m${override} name${zeroWidth}`, type: 'https', config: { url: 'https://odd.example.test' } })
    const token = await tokenWith('monitors:read')
    const text = (await call(token, 'list_monitors', { limit: 100 })).content[0]!.text
    assert.ok(text.includes('Odd red name'), text)
    assert.ok(hidden.every((char) => !text.includes(char)))
  })
})

describe('changing things', () => {
  const WRITE = ['incidents:write', 'maintenance:write', 'monitors:write'] as const
  const refused = async (token: string, name: string, args: Record<string, unknown>) => {
    const body = (await rpc(token, 'tools/call', { name, arguments: args })).json() as { result?: { isError?: boolean }; error?: unknown }
    return Boolean(body.error || body.result?.isError)
  }

  it('offers the tools that change data only to a token that may write, and marks them', async () => {
    const reader = await toolNames(await tokenWith('incidents:read', 'maintenance:read', 'monitors:read'))
    const readerTools = ((await rpc(await tokenWith('incidents:read', 'maintenance:read', 'monitors:read'), 'tools/list')).json() as { result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> } }).result.tools
    assert.ok(readerTools.every((tool) => tool.annotations['readOnlyHint'] === true), readerTools.map((tool) => tool.name).join())
    assert.ok(reader.length > 0)
    const writer = await tokenWith(...WRITE)
    const tools = ((await rpc(writer, 'tools/list')).json() as { result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> } }).result.tools
    const by = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]))
    assert.equal(by['incident_create_draft']!['readOnlyHint'], false)
    assert.equal(by['incident_create_draft']!['destructiveHint'], false)
    for (const name of ['incident_publish', 'incident_post_update', 'incident_update', 'incident_set_monitors', 'maintenance_create', 'maintenance_update', 'monitor_create', 'monitor_update', 'monitor_set_dependencies', 'monitors_apply']) assert.equal(by[name]!['destructiveHint'], true, name)
    assert.ok(!tools.some((tool) => /delete|remove/.test(tool.name)))
  })

  it('creates incidents as drafts, in silence, and the audit log names the token', async () => {
    const token = await tokenWith(...WRITE)
    const created = parsed(await call(token, 'incident_create_draft', { title: 'Database slow', impact: 'major' })) as { id: number }
    const stored = (await db.select().from(incidents)).find((incident) => incident.id === created.id)!
    assert.equal(stored.draft, 1)

    const entry = (await db.select().from(auditLog)).find((row) => row.entityType === 'incident' && row.entityName === 'Database slow')!
    assert.equal(entry.action, 'create')
    assert.equal(entry.userEmail, 'token: Agent')
  })

  it('needs an explicit notifySubscribers, posts updates, publishes and resolves', async () => {
    const token = await tokenWith(...WRITE)
    const { id } = parsed(await call(token, 'incident_create_draft', { title: 'Cache down' })) as { id: number }
    assert.equal(await refused(token, 'incident_publish', { id }), true, 'a call without notifySubscribers is refused')
    assert.equal((await db.select().from(incidents)).find((incident) => incident.id === id)!.draft, 1)

    assert.ok(!(await call(token, 'incident_post_update', { id, body: 'Looking', status: 'identified', notifySubscribers: true })).isError)
    assert.ok(!(await call(token, 'incident_publish', { id, notifySubscribers: false })).isError)
    assert.ok(!(await call(token, 'incident_post_update', { id, body: 'Fixed', status: 'resolved', notifySubscribers: false })).isError)
    const after = (await db.select().from(incidents)).find((incident) => incident.id === id)!
    assert.deepEqual([after.draft, after.status], [0, 'resolved'])
    assert.ok((await db.select().from(auditLog)).some((row) => row.entityType === 'incident' && row.userEmail === 'token: Agent' && row.action === 'update'))
  })

  it('schedules a window for named monitors only, with times that carry an offset', async () => {
    const token = await tokenWith(...WRITE)
    const monitor = await createMonitor({ name: 'Edge', type: 'https', config: { url: 'https://edge.example.test' } })
    const args = { name: 'Upgrade', startsAt: '2030-01-01T22:00:00+01:00', endsAt: '2030-01-01T23:00:00+01:00', monitorIds: [monitor.id], notifySubscribers: false }
    assert.equal((await call(token, 'maintenance_create', { ...args, startsAt: '2030-01-01T22:00:00' })).isError, true)
    assert.equal(await refused(token, 'maintenance_create', { ...args, monitorIds: [] }), true, 'a window for no named monitor is refused')

    assert.ok(!(await call(token, 'maintenance_create', args)).isError)
    const window = (await db.select().from(maintenanceWindows)).find((row) => row.name === 'Upgrade')!
    assert.equal(window.startsAt, Date.parse('2030-01-01T21:00:00Z'))
    assert.ok((await db.select().from(auditLog)).some((row) => row.entityType === 'maintenance' && row.userEmail === 'token: Agent'))
  })

  it('applies monitor YAML only after it was validated, and only monitors', async () => {
    const token = await tokenWith(...WRITE)
    const yaml = 'kind: Monitor\nkey: nightly-backup\nname: Nightly backup\ntype: webhook\nconfig: {}\n'
    const validated = parsed(await call(token, 'monitors_validate', { yaml })) as { planDigest: string }
    assert.ok(validated.planDigest)
    const exists = async () => (await db.select().from(monitors)).some((row) => row.key === 'nightly-backup')
    assert.equal(await exists(), false, 'validate changes nothing')

    assert.equal((await call(token, 'monitors_apply', { yaml, planDigest: 'wrong' })).isError, true)
    assert.equal((await call(token, 'monitors_apply', { yaml: yaml.replace('Nightly backup', 'Other'), planDigest: validated.planDigest })).isError, true)
    assert.equal(await exists(), false)

    const applied = await call(token, 'monitors_apply', { yaml, planDigest: validated.planDigest })
    assert.ok(!applied.isError, applied.content[0]!.text)
    assert.equal(await exists(), true)

    const channel = 'kind: NotificationChannel\nkey: x\nname: X\ntype: webhook\nconfig:\n  url: https://attacker.example.test\n'
    const broad = await tokenWith(...WRITE, 'channels:write')
    assert.match((await call(broad, 'monitors_validate', { yaml: channel })).content[0]!.text, /kind: Monitor/)
    assert.match((await call(broad, 'monitors_validate', { yaml: `${yaml}---\n${channel}` })).content[0]!.text, /kind: Monitor/)
    assert.equal((await db.select().from(notificationChannels)).length, 0)
  })

  it('changes an existing monitor only when told to, and says the plan updates it', async () => {
    const token = await tokenWith(...WRITE)
    const yaml = 'kind: Monitor\nkey: edit-me\nname: Edit me\ntype: webhook\nconfig: {}\n'
    const first = parsed(await call(token, 'monitors_validate', { yaml })) as { planDigest: string; updatesExisting: boolean }
    assert.equal(first.updatesExisting, false)
    assert.ok(!(await call(token, 'monitors_apply', { yaml, planDigest: first.planDigest })).isError)

    const changed = yaml.replace('Edit me', 'Edited')
    const second = parsed(await call(token, 'monitors_validate', { yaml: changed })) as { planDigest: string; updatesExisting: boolean }
    assert.equal(second.updatesExisting, true)
    assert.notEqual(second.planDigest, first.planDigest)
    assert.match((await call(token, 'monitors_apply', { yaml: changed, planDigest: second.planDigest })).content[0]!.text, /allowUpdates/)
    assert.equal((await db.select().from(monitors)).find((row) => row.key === 'edit-me')!.name, 'Edit me')
    assert.ok(!(await call(token, 'monitors_apply', { yaml: changed, planDigest: second.planDigest, allowUpdates: true })).isError)
    assert.equal((await db.select().from(monitors)).find((row) => row.key === 'edit-me')!.name, 'Edited')
  })

  it('changes one setting of a monitor and leaves everything else as it is', async () => {
    const token = await tokenWith(...WRITE)
    const created = await createMonitor({
      name: 'Cache XYZ', type: 'redis', intervalSecs: 60, timeoutMs: 5000, retries: 2,
      config: { host: 'cache.example.test', port: 6379, username: 'alice', password: 'kept-secret' },
    })
    const stored = async () => (await db.select().from(monitors)).find((row) => row.id === created.id)!
    const before = await stored()

    const result = await call(token, 'monitor_update', { id: created.id, intervalSecs: 120 })
    assert.ok(!result.isError, result.content[0]!.text)
    const after = await stored()
    assert.equal(after.intervalSecs, 120)
    assert.deepEqual(
      [after.name, after.timeoutMs, after.retries, after.config, after.key, after.tags],
      [before.name, before.timeoutMs, before.retries, before.config, before.key, before.tags],
    )
    assert.ok(!result.content[0]!.text.includes('kept-secret'))

    // A config field can change on its own too; the stored password stays.
    assert.ok(!(await call(token, 'monitor_update', { id: created.id, config: { username: 'bob' } })).isError)
    const config = JSON.parse((await stored()).config) as Record<string, unknown>
    assert.deepEqual([config['username'], config['host'], config['port'], config['password']], ['bob', 'cache.example.test', 6379, 'kept-secret'])
    // A kept password is not sent to a new address: the API refuses, as it does in the admin console.
    assert.equal((await call(token, 'monitor_update', { id: created.id, config: { port: 6380 } })).isError, true)

    const entry = (await db.select().from(auditLog)).find((row) => row.entityType === 'monitor' && row.entityName === 'Cache XYZ' && row.action === 'update')!
    assert.equal(entry.userEmail, 'token: Agent')
    assert.equal((await call(token, 'monitor_update', { id: created.id })).isError, true, 'nothing to change')
    assert.equal((await call(token, 'monitor_update', { id: created.id, intervalSecs: 1 })).isError, true, 'the API range applies')
  })

  it('changes the impact of an incident, and reschedules a one-time window within the same limits', async () => {
    const token = await tokenWith(...WRITE)
    const { id } = parsed(await call(token, 'incident_create_draft', { title: 'Slow' })) as { id: number }
    assert.equal((await call(token, 'incident_update', { id })).isError, true, 'nothing to change')
    assert.ok(!(await call(token, 'incident_update', { id, impact: 'critical', title: 'Very slow' })).isError)
    const row = (await db.select().from(incidents)).find((incident) => incident.id === id)!
    assert.deepEqual([row.impact, row.title, row.draft], ['critical', 'Very slow', 1])

    const monitor = await createMonitor({ name: 'Window', type: 'https', config: { url: 'https://window.example.test' } })
    const base = { name: 'Move me', startsAt: '2031-03-01T10:00:00Z', endsAt: '2031-03-01T11:00:00Z', monitorIds: [monitor.id], notifySubscribers: false }
    assert.ok(!(await call(token, 'maintenance_create', base)).isError)
    const window = (await db.select().from(maintenanceWindows)).find((entry) => entry.name === 'Move me')!
    assert.ok(!(await call(token, 'maintenance_update', { id: window.id, startsAt: '2031-03-01T23:00:00+01:00', endsAt: '2031-03-02T00:00:00+01:00' })).isError)
    const moved = (await db.select().from(maintenanceWindows)).find((entry) => entry.id === window.id)!
    assert.deepEqual([moved.startsAt, moved.endsAt, moved.name], [Date.parse('2031-03-01T22:00:00Z'), Date.parse('2031-03-01T23:00:00Z'), 'Move me'])
    assert.equal((await call(token, 'maintenance_update', { id: window.id, endsAt: '2031-04-01T00:00:00Z' })).isError, true, 'longer than a week')
    assert.equal((await call(token, 'maintenance_update', { id: window.id, endsAt: '2020-01-01T00:00:00Z', startsAt: '2019-12-31T00:00:00Z' })).isError, true, 'in the past')
    assert.equal((await call(token, 'maintenance_update', { id: window.id })).isError, true, 'nothing to change')
  })

  it('creates a monitor of any type, validated by the API, and sets its dependencies', async () => {
    const token = await tokenWith(...WRITE)
    assert.equal((await call(token, 'monitor_create', { name: 'Bad', type: 'nonsense', config: {} })).isError, true)
    const created = parsed(await call(token, 'monitor_create', { name: 'Fresh', type: 'ping', intervalSecs: 120, config: { host: 'fresh.example.test', mode: 'tcp', port: 443 } })) as { id: number }
    const stored = (await db.select().from(monitors)).find((row) => row.id === created.id)!
    assert.deepEqual([stored.name, stored.type, stored.intervalSecs], ['Fresh', 'ping', 120])
    assert.ok((await db.select().from(auditLog)).some((row) => row.entityType === 'monitor' && row.entityName === 'Fresh' && row.action === 'create' && row.userEmail === 'token: Agent'))

    const heartbeat = await call(token, 'monitor_create', { name: 'Job', type: 'webhook', config: {} })
    const text = heartbeat.content[0]!.text
    assert.match(text, /heartbeat/i)
    assert.ok(!text.includes((await db.select().from(monitors)).find((row) => row.name === 'Job')!.webhookToken!))

    const other = await createMonitor({ name: 'Upstream', type: 'https', config: { url: 'https://up.example.test' } })
    assert.ok(!(await call(token, 'monitor_set_dependencies', { id: created.id, dependsOnIds: [other.id] })).isError)
    assert.deepEqual((await db.select().from(monitorDependencies)).filter((row) => row.dependentId === created.id).map((row) => row.dependsOnId), [other.id])
    assert.equal((await call(token, 'monitor_set_dependencies', { id: other.id, dependsOnIds: [created.id] })).isError, true, 'a cycle is refused')

    const readers = await tokenWith('monitors:read', 'channels:read')
    const dependencies = parsed(await call(readers, 'monitor_dependencies', { id: created.id })) as { dependsOn: Array<{ id: number; name: string }> }
    assert.deepEqual(dependencies.dependsOn, [{ id: other.id, name: 'Upstream' }])
    assert.deepEqual((parsed(await call(readers, 'monitor_channels', { id: created.id })) as { channels: unknown[] }).channels, [])
    assert.ok(Array.isArray((parsed(await call(readers, 'list_channels')) as { items: unknown[] }).items))
  })

  it('reads templates, actions, action runs and subscriber counts, without addresses', async () => {
    const token = await tokenWith('incidents:read', 'actions:read', 'subscribers:read')
    for (const [name, key] of [['list_incident_templates', 'items'], ['list_actions', 'items'], ['list_action_runs', 'items']] as const) {
      const result = await call(token, name)
      assert.ok(!result.isError, `${name}: ${result.content[0]!.text}`)
      assert.ok(Array.isArray(parsed(result)[key]), name)
    }
    const counts = parsed(await call(token, 'subscriber_counts'))
    assert.deepEqual(Object.keys(counts).sort(), ['active', 'disabled', 'pending', 'total', 'unsubscribed'])
  })

  it('does not hand over channel addresses, recipients, topics or action requests', async () => {
    const channels: Array<[string, string, Record<string, unknown>]> = [
      ['Bot', 'telegram', { botToken: '123456:TELEGRAM-SECRET-TOKEN', chatId: '-100500' }],
      ['Hook', 'webhook', { url: 'https://hooks.example.test/services/WEBHOOK-PATH-TOKEN?key=QUERY-TOKEN', method: 'POST' }],
      ['Mail', 'email', { to: 'oncall-person@example.test' }],
      ['Push', 'ntfy', { topic: 'NTFY-SECRET-TOPIC', serverUrl: 'https://ntfy.example.test' }],
    ]
    for (const [name, type, config] of channels) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/admin/notifications/channels', headers: admin, payload: { name, type, config } })
      assert.equal(response.statusCode, 200, response.body)
    }
    const action = await app.inject({
      method: 'POST', url: '/api/v1/admin/actions', headers: admin,
      payload: { name: 'Failover', config: { url: 'https://jenkins.example.test/job/LITERAL-ACTION-TOKEN/build', method: 'POST', headers: { Authorization: 'Basic ACTION-HEADER-SECRET' }, body: '{"token":"ACTION-BODY-SECRET"}' } },
    })
    assert.equal(action.statusCode, 200, action.body)
    await db.insert(subscribers).values({
      type: 'email', targetKey: 'email:private-person@example.test', email: 'private-person@example.test', status: 'active', events: '[]',
      manageToken: 'x', manageTokenHash: 'x', createdAt: 1, updatedAt: 1,
    })

    const token = await tokenWith('channels:read', 'actions:read', 'subscribers:read')
    const text = [
      (await call(token, 'list_channels')).content[0]!.text,
      (await call(token, 'list_actions')).content[0]!.text,
      (await call(token, 'subscriber_counts')).content[0]!.text,
    ].join('\n')
    for (const secret of ['TELEGRAM-SECRET', 'WEBHOOK-PATH-TOKEN', 'QUERY-TOKEN', 'oncall-person', 'NTFY-SECRET-TOPIC', 'LITERAL-ACTION-TOKEN', 'ACTION-HEADER-SECRET', 'ACTION-BODY-SECRET', 'private-person', '-100500']) {
      assert.ok(!text.includes(secret), secret)
    }
    assert.ok(text.includes('hooks.example.test') && text.includes('jenkins.example.test'), 'the host is shown')
    assert.equal((parsed(await call(token, 'subscriber_counts')) as { total: number }).total >= 1, true)
  })

  it('refuses to change a resolved incident, a window that repeats, a past start and a change that drops a secret', async () => {
    const token = await tokenWith(...WRITE)
    const { id } = parsed(await call(token, 'incident_create_draft', { title: 'Closed soon' })) as { id: number }
    assert.ok(!(await call(token, 'incident_post_update', { id, body: 'Done', status: 'resolved', notifySubscribers: false })).isError)
    assert.equal((await call(token, 'incident_update', { id, impact: 'critical' })).isError, true)

    const monitor = await createMonitor({ name: 'Hdr', type: 'https', config: { url: 'https://hdr.example.test', headers: { Authorization: 'Bearer HEADER-SECRET' } } })
    const lost = await call(token, 'monitor_update', { id: monitor.id, config: { headers: { 'X-Trace': '1' } } })
    assert.equal(lost.isError, true)
    assert.match(lost.content[0]!.text, /drop a stored secret/)
    assert.ok(JSON.parse((await db.select().from(monitors)).find((row) => row.id === monitor.id)!.config).headers.Authorization.includes('HEADER-SECRET'))

    const window = await app.inject({
      method: 'POST', url: '/api/v1/admin/maintenance', headers: admin,
      payload: { name: 'Nightly', startsAt: Date.now() + 3_600_000, endsAt: Date.now() + 7_200_000, recurrence: 'daily', timezone: 'UTC', monitorIds: [monitor.id], notifySubscribers: false },
    })
    assert.equal(window.statusCode, 200, window.body)
    assert.match((await call(token, 'maintenance_update', { id: (window.json() as { id: number }).id, name: 'Renamed' })).content[0]!.text, /repeats/)

    const single = parsed(await call(token, 'maintenance_create', { name: 'Past', startsAt: '2031-05-01T10:00:00Z', endsAt: '2031-05-01T11:00:00Z', monitorIds: [monitor.id], notifySubscribers: false })) as { id: number }
    assert.equal((await call(token, 'maintenance_update', { id: single.id, startsAt: '2020-01-01T00:00:00Z' })).isError, true)
    assert.equal((await call(token, 'maintenance_create', { name: 'Old', startsAt: '2020-01-01T00:00:00Z', endsAt: new Date(Date.now() + 60_000).toISOString(), monitorIds: [monitor.id], notifySubscribers: false })).isError, true)

    const other = await createMonitor({ name: 'Real', type: 'https', config: { url: 'https://real.example.test' } })
    const stored = parsed(await call(token, 'monitor_set_dependencies', { id: monitor.id, dependsOnIds: [other.id, 999_999, monitor.id] })) as { dependsOnIds: number[] }
    assert.deepEqual(stored.dependsOnIds, [other.id])
  })

  it('does not let a token that cannot use the vault reference a vault secret', async () => {
    const token = await tokenWith(...WRITE)
    const result = await call(token, 'monitor_create', { name: 'Vaulted', type: 'postgresql', config: { host: 'db.example.test', port: 5432, database: 'app', vault: { vaultId: 1, secretId: 1, fieldMapping: { user: 'u', password: 'p' } } } })
    assert.equal(result.isError, true)
    assert.match(result.content[0]!.text, /403.*vault/i)
    assert.equal((await db.select().from(monitors)).some((row) => row.name === 'Vaulted'), false)
  })

  it('limits a maintenance window to the future and to a week, and wants a real time zone', async () => {
    const token = await tokenWith(...WRITE)
    const monitor = await createMonitor({ name: 'Limits', type: 'https', config: { url: 'https://limits.example.test' } })
    const args = { name: 'Limit', startsAt: '2031-01-01T00:00:00Z', endsAt: '2031-01-02T00:00:00Z', monitorIds: [monitor.id], notifySubscribers: false }
    for (const bad of [
      { endsAt: '2020-01-01T00:00:00Z', startsAt: '2019-12-31T00:00:00Z' },
      { endsAt: '2031-02-01T00:00:00Z' },
      { startsAt: 'next friday 10z' },
      { startsAt: '2031-01-01 00:00:00' },
    ]) assert.equal((await call(token, 'maintenance_create', { ...args, ...bad })).isError, true, JSON.stringify(bad))
    assert.ok(!(await call(token, 'maintenance_create', args)).isError)
  })

  it('ends a window and checks a monitor now, and refuses a batch of calls', async () => {
    const token = await tokenWith(...WRITE)
    const monitor = await createMonitor({ name: 'Now', type: 'webhook', config: {} })
    const checked = parsed(await call(token, 'monitor_check_now', { id: monitor.id })) as Record<string, unknown>
    assert.equal(checked['id'], monitor.id)
    assert.ok(!('webhookToken' in checked) && !('config' in checked))

    const start = new Date(Date.now() - 60_000).toISOString()
    const end = new Date(Date.now() + 3_600_000).toISOString()
    assert.ok(!(await call(token, 'maintenance_create', { name: 'Running', startsAt: start, endsAt: end, monitorIds: [monitor.id], notifySubscribers: false })).isError)
    const window = (await db.select().from(maintenanceWindows)).find((row) => row.name === 'Running')!
    assert.ok(!(await call(token, 'maintenance_end', { id: window.id })).isError)
    assert.ok((await db.select().from(maintenanceWindows)).find((row) => row.id === window.id)!.endsAt <= Date.now() + 1000)

    const tools = ((await rpc(token, 'tools/list')).json() as { result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> } }).result.tools
    for (const name of ['maintenance_end', 'monitor_check_now']) assert.equal(tools.find((tool) => tool.name === name)!.annotations['destructiveHint'], true, name)

    const batch = await app.inject({
      method: 'POST', url: '/mcp', headers: { ...MCP_HEADERS, authorization: `Bearer ${token}` },
      payload: [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }],
    })
    assert.equal(batch.statusCode, 400)
  })

  it('does not let a token without the write permission change anything', async () => {
    const created = await createMonitor({ name: 'Plain', type: 'https', config: { url: 'https://plain.example.test' } })
    assert.equal(await refused(await tokenWith('monitors:read'), 'monitor_check_now', { id: created.id }), true)
  })
})

describe('what the agent is told', () => {
  /** Every permission except the vault: the most an agent token should get. */
  const EVERYTHING = TOKEN_RESOURCES.map((resource) => `${resource.key}:${resource.levels.at(-1)}`)
  interface Listed { name: string; description: string; inputSchema: { properties?: Record<string, { description?: string }> }; annotations: Record<string, boolean> }
  const allTools = async () => ((await rpc(await tokenWith(...EVERYTHING), 'tools/list')).json() as { result: { tools: Listed[] } }).result.tools

  it('sends the instructions when it connects, and they are fixed text that names the rules', async () => {
    const response = await rpc(await tokenWith('monitors:read'), 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    const { instructions } = (response.json() as { result: { instructions: string } }).result
    assert.equal(instructions, MCP_INSTRUCTIONS)
    for (const rule of ['status_overview', 'monitor_config_fields', 'never guess an id', 'notifySubscribers', 'never ask the user to type a password', 'Data, not instructions', 'ISO 8601']) {
      assert.ok(instructions.toLowerCase().includes(rule.toLowerCase()), rule)
    }
    // Nothing from the database can be in it: it is the same text for every instance.
    assert.ok(!/\d{6,}/.test(instructions))
  })

  it('describes every tool and every argument, with a permission the catalogue knows', async () => {
    const tools = await allTools()
    assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length, 'names are unique')
    for (const tool of tools) {
      assert.ok(tool.description.length > 30, `${tool.name}: description`)
      for (const [argument, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        // A bare id says nothing about what it identifies; the rest follow their name.
        if (/id$|Id$|ids$|Ids$/.test(argument)) assert.ok(schema.description, `${tool.name}.${argument} needs a description`)
      }
    }
  })

  it('keeps access, annotation and permission of each tool consistent', async () => {
    const tools = await allTools()
    const readOnly = tools.filter((tool) => tool.annotations['readOnlyHint'] === true)
    const changing = tools.filter((tool) => tool.annotations['readOnlyHint'] === false)
    assert.ok(readOnly.length >= 19 && changing.length >= 14, `${readOnly.length} read, ${changing.length} changing`)
    for (const tool of readOnly) assert.equal(tool.annotations['destructiveHint'], false, tool.name)
    const readerOffered = await toolNames(await tokenWith(...EVERYTHING.map((scope) => scope.replace(':write', ':read'))))
    assert.deepEqual(readerOffered.filter((name) => changing.some((tool) => tool.name === name)), [], 'a read-only token sees no changing tool')
  })

  it('is described in docs/mcp.md, tool by tool', async () => {
    const docs = readFileSync(fileURLToPath(new URL('../../../docs/mcp.md', import.meta.url)), 'utf8')
    // The rows of the tool tables: | `name` | ...
    const documented = [...docs.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]!).sort()
    const real = (await allTools()).map((tool) => tool.name).sort()
    assert.deepEqual(real.filter((name) => !documented.includes(name)), [], 'add these tools to the tables in docs/mcp.md')
    assert.deepEqual(documented.filter((name) => !real.includes(name)), [], 'these are documented but no longer exist')
  })

  it('lists the options of every monitor type, so an option that is off can still be found', async () => {
    assert.deepEqual(Object.keys(MONITOR_CONFIG_SCHEMAS).sort(), [...MONITOR_TYPES].sort())
    const token = await tokenWith('monitors:read')
    const overview = parsed(await call(token, 'monitor_config_fields')) as { types: Array<{ type: string; summary: string }> }
    assert.deepEqual(overview.types.map((entry) => entry.type), [...MONITOR_TYPES])
    assert.ok(overview.types.every((entry) => entry.summary.length > 10))

    for (const type of MONITOR_TYPES) {
      const described = parsed(await call(token, 'monitor_config_fields', { type })) as { configSchema: { type: string; properties: Record<string, unknown> }; settings: Array<{ name: string }> }
      assert.equal(described.configSchema.type, 'object', type)
      assert.deepEqual(described.settings.map((setting) => setting.name), Object.keys(MONITOR_SETTINGS), type)
    }
    type Described = { configSchema: { required?: string[]; properties: Record<string, { description?: string; secret?: boolean; unchecked?: boolean; default?: unknown }> } }
    const https = parsed(await call(token, 'monitor_config_fields', { type: 'https' })) as Described
    assert.match(https.configSchema.properties['cacheBuster']!.description!, /bypass cache/i)
    assert.equal(https.configSchema.properties['cacheBuster']!.default, false)
    assert.deepEqual(https.configSchema.required, ['url'], 'the agent is told the address is required')
    assert.equal(https.configSchema.properties['keyword']!.unchecked, true, 'and which fields the API does not check')
    const database = parsed(await call(token, 'monitor_config_fields', { type: 'postgresql' })) as Described
    assert.equal(database.configSchema.properties['password']!.secret, true)
    const redis = parsed(await call(token, 'monitor_config_fields', { type: 'redis' })) as Described
    assert.deepEqual(redis.configSchema.required, ['host', 'port'])
  })

  it('lets an agent turn on an option that get_monitor does not show, and leaves the rest alone', async () => {
    const created = await createMonitor({ name: 'mmorpg', type: 'https', intervalSecs: 60, config: { url: 'https://mmorpg.example.test', method: 'GET', expectedStatus: 200, auth: { type: 'none' } } })
    const token = await tokenWith('monitors:write')
    const shown = parsed(await call(token, 'get_monitor', { id: created.id })) as { config: Record<string, unknown> }
    assert.equal('cacheBuster' in shown.config, false, 'an option that is off is absent')

    assert.ok(!(await call(token, 'monitor_update', { id: created.id, config: { cacheBuster: true } })).isError)
    const after = JSON.parse((await db.select().from(monitors)).find((row) => row.id === created.id)!.config) as Record<string, unknown>
    assert.deepEqual(after, { url: 'https://mmorpg.example.test', method: 'GET', expectedStatus: 200, auth: { type: 'none' }, cacheBuster: true })
    assert.equal((await call(token, 'monitor_update', { id: created.id, config: { cacheBuster: 'yes' } })).isError, true, 'the API checks the type')
  })

  it('sets tags, the automatic incident and the slower-than-usual alert like the monitor form', async () => {
    const token = await tokenWith('monitors:write')
    const created = await createMonitor({ name: 'Form parity', type: 'https', config: { url: 'https://form.example.test' } })
    const result = await call(token, 'monitor_update', {
      id: created.id, tags: [{ label: 'prod', color: '#ff0000' }], autoIncidentMinutes: 15, autoIncidentMode: 'draft',
      latencyAlertFactor: 4, latencyAlertWindowMinutes: 60, latencyAlertSustain: 5,
    })
    assert.ok(!result.isError, result.content[0]!.text)
    const row = (await db.select().from(monitors)).find((entry) => entry.id === created.id)!
    assert.deepEqual(JSON.parse(row.tags), [{ label: 'prod', color: '#ff0000' }])
    assert.deepEqual([row.autoIncidentMinutes, row.autoIncidentMode, row.latencyAlertFactor, row.latencyAlertWindowMinutes, row.latencyAlertSustain], [15, 'draft', 4, 60, 5])
    // Publishing automatic incidents is incidents:write territory, and the API says so.
    const refused = await call(token, 'monitor_update', { id: created.id, autoIncidentMode: 'published' })
    assert.equal(refused.isError, true)
    assert.match(refused.content[0]!.text, /incidents:write/)
    const both = await tokenWith('monitors:write', 'incidents:write')
    assert.ok(!(await call(both, 'monitor_update', { id: created.id, autoIncidentMode: 'published' })).isError)
    assert.equal((await db.select().from(monitors)).find((entry) => entry.id === created.id)!.autoIncidentMode, 'published')
    assert.ok(!(await call(token, 'monitor_update', { id: created.id, autoIncidentMinutes: null, latencyAlertFactor: null })).isError)
    assert.equal((await db.select().from(monitors)).find((entry) => entry.id === created.id)!.autoIncidentMinutes, null)
  })
})

describe('what an agent cannot do by mistake', () => {
  const WRITE = ['incidents:write', 'maintenance:write', 'monitors:write'] as const

  it('does not touch a resolved incident, however it is asked', async () => {
    const token = await tokenWith(...WRITE)
    const { id } = parsed(await call(token, 'incident_create_draft', { title: 'Closed' })) as { id: number }
    assert.ok(!(await call(token, 'incident_post_update', { id, body: 'Done', status: 'resolved', notifySubscribers: false })).isError)
    const monitor = await createMonitor({ name: 'Linked', type: 'https', config: { url: 'https://linked.example.test' } })
    for (const [name, args] of [
      ['incident_post_update', { id, body: 'Again', status: 'investigating', notifySubscribers: false }],
      ['incident_set_monitors', { id, monitorIds: [monitor.id] }],
      ['incident_update', { id, title: 'Rewritten' }],
    ] as const) {
      const result = await call(token, name, args)
      assert.equal(result.isError, true, name)
      assert.match(result.content[0]!.text, /resolved/, name)
    }
    assert.deepEqual((await db.select().from(incidents)).filter((row) => row.id === id).map((row) => [row.status, row.title]), [['resolved', 'Closed']])
  })

  it('does not make a monitor that sends anything but GET, POST or HEAD', async () => {
    const token = await tokenWith(...WRITE)
    for (const method of ['DELETE', 'PUT', 'PATCH', 'TRACE', 5]) {
      const result = await call(token, 'monitor_create', { name: `Bad ${String(method)}`, type: 'https', config: { url: 'https://a.example.test', method } })
      assert.equal(result.isError, true, String(method))
      assert.match(result.content[0]!.text, /method/)
    }
    assert.equal((await db.select().from(monitors)).some((row) => row.name.startsWith('Bad ')), false)
    const ok = parsed(await call(token, 'monitor_create', { name: 'Head only', type: 'https', config: { url: 'https://a.example.test', method: 'head' } })) as { id: number }
    assert.equal((await call(token, 'monitor_update', { id: ok.id, config: { method: 'DELETE' } })).isError, true)
    assert.equal(JSON.parse((await db.select().from(monitors)).find((row) => row.id === ok.id)!.config).method, 'head')
  })

  it('rejects an argument that does not exist instead of ignoring it', async () => {
    const token = await tokenWith(...WRITE)
    const monitor = await createMonitor({ name: 'Typo', type: 'redis', config: { host: 'cache.example.test', port: 6379 } })
    const response = await rpc(token, 'tools/call', { name: 'monitor_update', arguments: { id: monitor.id, enabled: false, intervalSecs: 120 } })
    const body = response.json() as { result?: { isError?: boolean }; error?: unknown }
    assert.ok(body.error || body.result?.isError, 'refused')
    assert.equal((await db.select().from(monitors)).find((row) => row.id === monitor.id)!.intervalSecs, 60, 'and nothing was changed')
    const tools = ((await rpc(token, 'tools/list')).json() as { result: { tools: Array<{ name: string; inputSchema: { additionalProperties?: boolean } }> } }).result.tools
    assert.ok(tools.every((tool) => tool.inputSchema.additionalProperties === false), 'the schema tells the client too')
  })

  it('holds the method rule for monitors applied from YAML too', async () => {
    const token = await tokenWith(...WRITE)
    const yaml = (method: string) => `kind: Monitor\nkey: yaml-method\nname: Yaml method\ntype: https\nconfig:\n  url: https://yaml.example.test\n  method: ${method}\n`
    for (const [tool, extra] of [['monitors_validate', {}], ['monitors_apply', { planDigest: 'x' }]] as const) {
      const result = await call(token, tool, { yaml: yaml('DELETE'), ...extra })
      assert.equal(result.isError, true, tool)
      assert.match(result.content[0]!.text, /method/, tool)
    }
    assert.equal((await db.select().from(monitors)).some((row) => row.key === 'yaml-method'), false)
    assert.ok(!(await call(token, 'monitors_validate', { yaml: yaml('GET') })).isError)
  })

  it('lets a window made in the console be renamed, but not stretched past a week', async () => {
    const token = await tokenWith(...WRITE)
    const monitor = await createMonitor({ name: 'Long', type: 'https', config: { url: 'https://long.example.test' } })
    const created = await app.inject({
      method: 'POST', url: '/api/v1/admin/maintenance', headers: admin,
      payload: { name: 'Quarter', startsAt: Date.now() + 3_600_000, endsAt: Date.now() + 10 * 24 * 3_600_000, monitorIds: [monitor.id], notifySubscribers: false },
    })
    const { id } = created.json() as { id: number }
    assert.ok(!(await call(token, 'maintenance_update', { id, name: 'Quarter (renamed)' })).isError, 'a rename does not look at the length')
    assert.equal((await call(token, 'maintenance_update', { id, endsAt: new Date(Date.now() + 11 * 24 * 3_600_000).toISOString() })).isError, true)
  })
})

describe('the switch in the admin console', () => {
  const put = (payload: Record<string, unknown>, headers: Record<string, string> = admin) =>
    app.inject({ method: 'PUT', url: '/api/v1/admin/mcp', headers, payload })
  const read = async () => (await app.inject({ url: '/api/v1/admin/mcp', headers: admin })).json() as { enabled: boolean; allowChanges: boolean }

  it('is off by default, and while off /mcp answers like a path that does not exist', async () => {
    await db.delete(mcpSettings)
    assert.deepEqual(await read(), { enabled: false, allowChanges: false, publicUrl: null })
    const token = await tokenWith('monitors:read')
    for (const method of ['POST', 'GET', 'DELETE'] as const) {
      const response = await app.inject({ method, url: '/mcp', headers: { ...MCP_HEADERS, authorization: `Bearer ${token}` }, payload: method === 'POST' ? { jsonrpc: '2.0', id: 1, method: 'tools/list' } : undefined })
      assert.equal(response.statusCode, 404, method)
      assert.equal(String(response.headers['www-authenticate'] ?? ''), '', 'not even a hint that an endpoint is here')
    }
    // Not even the cross-site check, the rate limit or the body are looked at first: nothing tells it apart from a missing route.
    const foreign = await app.inject({ method: 'POST', url: '/mcp', headers: { ...MCP_HEADERS, origin: 'https://evil.example' }, payload: {} })
    assert.equal(foreign.statusCode, 404)
    await setMcp(true, true)
  })

  it('turns on at once, without a restart, and off again at once', async () => {
    await setMcp(false, false)
    const token = await tokenWith('monitors:read')
    assert.equal((await rpc(token, 'tools/list')).statusCode, 404)
    const on = await put({ enabled: true, currentPassword: PASSWORD })
    assert.equal(on.statusCode, 200, on.body)
    assert.equal((await rpc(token, 'tools/list')).statusCode, 200)
    assert.equal((await put({ enabled: false })).statusCode, 200)
    assert.equal((await rpc(token, 'tools/list')).statusCode, 404)
    await setMcp(true, true)
  })

  it('asks for the password to turn something on, but not to turn it off', async () => {
    await setMcp(false, false)
    assert.equal((await put({ enabled: true })).statusCode, 400, 'no password')
    assert.equal((await put({ enabled: true, currentPassword: 'wrong' })).statusCode, 400, 'wrong password')
    assert.equal((await read()).enabled, false)
    assert.equal((await put({ enabled: true, currentPassword: PASSWORD })).statusCode, 200)
    assert.equal((await put({ allowChanges: true })).statusCode, 400, 'allowing changes is confirmed too')
    assert.equal((await put({ allowChanges: true, currentPassword: PASSWORD })).statusCode, 200)
    assert.equal((await put({ allowChanges: false })).statusCode, 200, 'turning changes off needs no password')
    assert.equal((await put({ enabled: false })).statusCode, 200, 'turning MCP off needs no password')
    await setMcp(true, true)
  })

  it('turns the changes off with MCP, and refuses changes without MCP', async () => {
    await setMcp(true, true)
    assert.deepEqual(await put({ enabled: false }).then((response) => response.json()), { enabled: false, allowChanges: false, publicUrl: null })
    assert.equal((await put({ allowChanges: true, currentPassword: PASSWORD })).statusCode, 400)
    assert.equal((await put({ enabled: 'yes' })).statusCode, 400)
    assert.equal((await put({ allowChanges: 1 })).statusCode, 400)
    await setMcp(true, true)
  })

  it('offers only the tools that read while changes are not allowed, whatever the token may do', async () => {
    const token = await tokenWith('monitors:write', 'incidents:write', 'maintenance:write')
    await setMcp(true, false)
    const readOnly = ((await rpc(token, 'tools/list')).json() as { result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> } }).result.tools
    assert.ok(readOnly.length > 0 && readOnly.every((tool) => tool.annotations['readOnlyHint'] === true), readOnly.map((tool) => tool.name).join())
    const refused = await rpc(token, 'tools/call', { name: 'incident_create_draft', arguments: { title: 'Sneaky' } })
    assert.match(JSON.stringify(refused.json()), /not found/i)
    assert.equal((await db.select().from(incidents)).some((row) => row.title === 'Sneaky'), false)

    await setMcp(true, true)
    assert.ok((await toolNames(token)).includes('incident_create_draft'))
  })

  it('is for administrators only: an operator or a branding user gets nothing, and nothing changes', async () => {
    for (const role of ['operator', 'branding']) {
      const headers = sessionOf[role]!
      assert.equal((await app.inject({ url: '/api/v1/admin/mcp', headers })).statusCode, 403, role)
      assert.equal((await put({ enabled: false }, headers)).statusCode, 403, role)
      assert.equal((await put({ enabled: true, currentPassword: PASSWORD }, headers)).statusCode, 403, role)
    }
    assert.equal((await app.inject({ url: '/api/v1/admin/mcp' })).statusCode, 401)
    assert.equal((await read()).enabled, true)
  })

  it('limits the password guesses like every other place that asks for the password', () => {
    const route = routeOptions.find((entry) => entry.url === '/api/v1/admin/mcp/' && String(entry.method).includes('PUT'))
    assert.equal((route?.config as { rateLimit?: { groupId?: string } } | undefined)?.rateLimit?.groupId, 'sensitive-action')
  })

  it('changes nothing, and writes nothing, when the request asks for what already is', async () => {
    await setMcp(true, false)
    const before = (await db.select().from(mcpSettings))[0]!
    const entries = (await db.select().from(auditLog)).filter((row) => row.entityType === 'mcp_settings').length
    for (const body of [{}, { enabled: true }, { allowChanges: false }, { enabled: true, allowChanges: false }]) {
      assert.equal((await put(body)).statusCode, 200, JSON.stringify(body))
    }
    assert.equal((await db.select().from(mcpSettings))[0]!.updatedAt, before.updatedAt, 'the row was not rewritten')
    assert.equal((await db.select().from(auditLog)).filter((row) => row.entityType === 'mcp_settings').length, entries)
    await setMcp(true, true)
  })

  it('records only the two switches in the audit log, never the password', async () => {
    await setMcp(true, false)
    assert.equal((await put({ allowChanges: true, currentPassword: PASSWORD })).statusCode, 200)
    const entry = (await db.select().from(auditLog)).filter((row) => row.entityType === 'mcp_settings').at(-1)!
    assert.deepEqual(JSON.parse(entry.diff ?? '{}'), { allowChanges: { from: false, to: true } })
    assert.ok(!JSON.stringify(entry).includes(PASSWORD))
    await setMcp(true, true)
  })

  it('cannot be switched by an API token, and is recorded in the audit log', async () => {
    const everything = await tokenWith(...TOKEN_RESOURCES.map((resource) => `${resource.key}:${resource.levels.at(-1)}`))
    const headers = { authorization: `Bearer ${everything}` }
    assert.equal((await app.inject({ url: '/api/v1/admin/mcp', headers })).statusCode, 403)
    assert.equal((await put({ enabled: false }, headers)).statusCode, 403)
    assert.equal((await read()).enabled, true)

    await put({ enabled: false })
    await put({ enabled: true, currentPassword: PASSWORD })
    const entries = (await db.select().from(auditLog)).filter((row) => row.entityType === 'mcp_settings')
    assert.ok(entries.length >= 2 && entries.every((row) => row.userEmail === 'admin@example.test'))
    await setMcp(true, true)
  })

  it('answers 404 at /mcp in production when nothing is registered there', () => {
    const sent: Array<[number, unknown]> = []
    const reply = { code: (status: number) => ({ send: (body: unknown) => { sent.push([status, body]) } }), sendFile: () => { sent.push([200, 'index.html']) } }
    const fallback = createProductionFallback('/dist')
    for (const url of ['/mcp', '/mcp/', '/mcp?x=1', '/api/v1/nothing']) fallback({ url } as never, reply as never)
    fallback({ url: '/mcpx' } as never, reply as never)
    assert.deepEqual(sent.map(([status]) => status), [404, 404, 404, 404, 200])
  })
})
