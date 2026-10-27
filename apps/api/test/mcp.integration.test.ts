import assert from 'node:assert/strict'

process.env['UPDATE_CHECK'] = 'false'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import bcrypt from 'bcryptjs'
import jwt from '@fastify/jwt'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import { adminApi } from '../src/adminApi.js'
import { getMcpConfig } from '../src/config/mcp.js'
import { db } from '../src/db/client.js'
import { authSessions, users } from '../src/db/schema.js'
import { auth } from '../src/kit/auth.js'
import { registerMcp } from '../src/mcp/register.js'
import { createProductionFallback } from '../src/services/productionFallback.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const PASSWORD = 'admin-password'
const testDb = createTestDb('bsp-mcp-')
process.env['UPLOAD_DIR'] = join(testDb.dir, 'uploads')
const app = Fastify({ logger: false })
let admin: { authorization: string }

before(async () => {
  initTestDb()
  await app.register(cookie)
  await app.register(jwt, { secret: 'test-secret-with-sufficient-entropy' })
  await app.register(multipart)
  await app.register(adminApi, { prefix: '/api/v1/admin' })
  registerMcp(app)
  await app.ready()

  const now = Date.now()
  const [user] = await db.insert(users).values({ email: 'admin@example.test', passwordHash: await bcrypt.hash(PASSWORD, 4), role: 'admin', createdAt: now }).returning()
  await db.insert(authSessions).values({ id: 'session-admin', userId: user!.id, csrfTokenHash: 'unused', createdAt: now, lastSeenAt: now, expiresAt: now + 60_000 })
  admin = { authorization: `Bearer ${app.jwt.sign({ userId: user!.id, email: user!.email, role: 'admin', sessionId: 'session-admin' })}` }
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

beforeEach(() => {
  auth.apiTokens.resetApiTokenBudgets()
  delete process.env['PUBLIC_URL']
})

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
    assert.deepEqual(monitorsOnly.sort(), ['get_monitor', 'list_monitors', 'monitor_results', 'monitor_stats', 'status_overview'])

    const everything = await tokenWith('monitors:read', 'incidents:read', 'maintenance:read', 'channels:read', 'reports:read', 'audit:read', 'system:read')
    const names = await toolNames(everything)
    assert.equal(names.length, 12)
    assert.ok(names.every((name) => !/^(create|update|delete|publish|post|resolve|apply|end|reset)/.test(name)), names.join())

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

describe('switching it on', () => {
  it('is off unless MCP_ENABLED is true, and a mistaken value stops the start', () => {
    assert.deepEqual(getMcpConfig({}), { enabled: false })
    assert.deepEqual(getMcpConfig({ MCP_ENABLED: '' }), { enabled: false })
    assert.deepEqual(getMcpConfig({ MCP_ENABLED: 'false' }), { enabled: false })
    assert.deepEqual(getMcpConfig({ MCP_ENABLED: ' TRUE ' }), { enabled: true })
    for (const bad of ['1', 'yes', 'on', 'enabled']) assert.throws(() => getMcpConfig({ MCP_ENABLED: bad }), /MCP_ENABLED/)
  })

  it('answers 404, not the status page, at /mcp when nothing is registered there', () => {
    const sent: Array<[number, unknown]> = []
    const reply = { code: (status: number) => ({ send: (body: unknown) => { sent.push([status, body]) } }), sendFile: () => { sent.push([200, 'index.html']) } }
    const fallback = createProductionFallback('/dist')
    for (const url of ['/mcp', '/mcp/', '/mcp?x=1', '/api/v1/nothing']) fallback({ url } as never, reply as never)
    fallback({ url: '/mcpx' } as never, reply as never)
    assert.deepEqual(sent.map(([status]) => status), [404, 404, 404, 404, 200])
  })
})
