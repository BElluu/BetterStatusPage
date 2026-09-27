import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import jwt from '@fastify/jwt'
import { requireAuth, requireRole } from '../src/middleware/auth.js'
import { authSessions, users, vaultSecrets, vaults } from '../src/db/schema.js'
import { db } from '../src/db/client.js'
import { encrypt } from '../src/crypto/vault.js'
import { monitorRoutes } from '../src/routes/monitors.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-test-runner-route-')
process.env['VAULT_ENCRYPTION_KEY'] = 'abcdef0123456789'.repeat(4)

const app = Fastify({ logger: false })
const authorizations: Record<string, { authorization: string }> = {}
const sessionTokens: Record<string, string> = {}

let lastAuthorization = ''
const httpServer = createHttpServer((req, res) => {
  lastAuthorization = req.headers.authorization ?? ''
  const expected = `Basic ${Buffer.from('vault-user:vault-pass').toString('base64')}`
  if (req.url === '/protected') res.writeHead(lastAuthorization === expected ? 200 : 401).end('protected')
  else res.writeHead(200).end('ok')
})
const tcpServer = createTcpServer((socket) => socket.destroy())

let baseUrl = ''
let tcpPort = 0
let vaultId = 0
let userpassSecretId = 0
let emptyValueSecretId = 0

before(async () => {
  initTestDb()

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const httpAddress = httpServer.address()
  if (!httpAddress || typeof httpAddress === 'string') throw new Error('HTTP test server did not bind')
  baseUrl = `http://127.0.0.1:${httpAddress.port}`

  await new Promise<void>((resolve) => tcpServer.listen(0, '127.0.0.1', resolve))
  const tcpAddress = tcpServer.address()
  if (!tcpAddress || typeof tcpAddress === 'string') throw new Error('TCP test server did not bind')
  tcpPort = tcpAddress.port

  const now = Date.now()
  const [vault] = await db.insert(vaults).values({ name: 'Monitors', createdAt: now, updatedAt: now }).returning()
  vaultId = vault!.id
  const [userpass, emptyValue] = await db.insert(vaultSecrets).values([
    { vaultId, name: 'Service login', type: 'userpass', encryptedValue: encrypt(JSON.stringify({ username: 'vault-user', password: 'vault-pass' })), createdAt: now, updatedAt: now },
    { vaultId, name: 'Empty connection string', type: 'value', encryptedValue: encrypt(JSON.stringify({ value: '' })), createdAt: now, updatedAt: now },
  ]).returning()
  userpassSecretId = userpass!.id
  emptyValueSecretId = emptyValue!.id

  // Same guard chain as the production admin API in src/index.ts.
  await app.register(jwt, { secret: 'test-secret-with-sufficient-entropy' })
  await app.register(cookie)
  await app.register(async (adminApp) => {
    adminApp.addHook('preHandler', requireAuth)
    await adminApp.register(async (sub) => {
      sub.addHook('preHandler', requireRole('operator'))
      await sub.register(monitorRoutes, { prefix: '/monitors' })
    })
  }, { prefix: '/api/v1/admin' })
  await app.ready()

  for (const role of ['admin', 'operator', 'branding']) {
    const [user] = await db.insert(users).values({ email: `${role}@example.test`, passwordHash: 'unused', role, createdAt: now }).returning()
    const sessionId = `session-${role}`
    await db.insert(authSessions).values({ id: sessionId, userId: user!.id, csrfTokenHash: 'unused', createdAt: now, lastSeenAt: now, expiresAt: now + 60 * 60_000 })
    const token = app.jwt.sign({ userId: user!.id, email: user!.email, role, sessionId })
    authorizations[role] = { authorization: `Bearer ${token}` }
    sessionTokens[role] = token
  }
})

after(async () => {
  await app.close()
  httpServer.closeAllConnections()
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  await new Promise<void>((resolve) => tcpServer.close(() => resolve()))
  teardownTestDb(testDb)
})

function runTest(payload: unknown, headers: Record<string, string> = authorizations['admin']!) {
  return app.inject({ method: 'POST', url: '/api/v1/admin/monitors/test', headers, payload: payload as Record<string, unknown> })
}

describe('POST /admin/monitors/test', () => {
  it('rejects unauthenticated requests and roles below operator', async () => {
    const payload = { type: 'ping', config: { host: '127.0.0.1', mode: 'tcp', port: tcpPort } }
    assert.equal((await runTest(payload, {})).statusCode, 401)
    assert.equal((await runTest(payload, { authorization: 'Bearer not-a-jwt' })).statusCode, 401)
    assert.equal((await runTest(payload, authorizations['branding'])).statusCode, 403)
  })

  it('requires a CSRF token for cookie sessions', async () => {
    const response = await runTest(
      { type: 'ping', config: { host: '127.0.0.1', mode: 'tcp', port: tcpPort } },
      { cookie: `bsp_session=${sessionTokens['operator']}` },
    )
    assert.equal(response.statusCode, 403)
    assert.deepEqual(response.json(), { error: 'Invalid CSRF token' })
  })

  it('runs a TCP ping test for an operator', async () => {
    const response = await runTest({ type: 'ping', config: { host: '127.0.0.1', mode: 'tcp', port: tcpPort }, timeoutMs: 1_000 }, authorizations['operator'])
    assert.equal(response.statusCode, 200)
    const result = response.json()
    assert.equal(result.overall, 'ok')
    assert.equal(result.steps[0].label, `TCP connect to 127.0.0.1:${tcpPort}`)
  })

  it('runs an HTTPS test with credentials resolved from the vault', async () => {
    const response = await runTest({
      type: 'https',
      config: { url: `${baseUrl}/protected`, method: 'GET', expectedStatus: 200, auth: { type: 'basic', basic: { username: '', password: '', vault: { vaultId, secretId: userpassSecretId } } } },
      timeoutMs: 2_000,
    })
    assert.equal(response.statusCode, 200)
    const result = response.json()
    assert.equal(result.overall, 'ok', JSON.stringify(result.steps))
    assert.equal(result.steps[0].label, 'Basic Auth: credentials resolved from Vault')
    assert.equal(lastAuthorization, `Basic ${Buffer.from('vault-user:vault-pass').toString('base64')}`)
    assert.doesNotMatch(response.body, /vault-pass/)
  })

  it('reports a missing vault secret as a failed step instead of an error response', async () => {
    const response = await runTest({
      type: 'https',
      config: { url: `${baseUrl}/protected`, method: 'GET', expectedStatus: 200, auth: { type: 'basic', basic: { username: '', password: '', vault: { vaultId, secretId: 99_999 } } } },
    })
    assert.equal(response.statusCode, 200)
    const result = response.json()
    assert.equal(result.overall, 'error')
    assert.equal(result.steps.at(-1).label, 'Basic Auth: failed to resolve credentials')
  })

  it('returns failed DNS and SQL Server tests as results', async () => {
    const dns = await runTest({ type: 'dns', config: { hostname: 'example.invalid', recordType: 'A', resolver: '127.0.0.1:1' }, timeoutMs: 500 })
    assert.equal(dns.statusCode, 200)
    assert.equal(dns.json().overall, 'error')

    const sql = await runTest({ type: 'sqlserver', config: { host: '127.0.0.1', port: 1, database: 'missing', user: 'sa', password: 'x', query: 'SELECT 1' }, timeoutMs: 500 })
    assert.equal(sql.statusCode, 200)
    assert.equal(sql.json().overall, 'error')

    const emptyConnectionString = await runTest({
      type: 'sqlserver',
      config: { mode: 'connectionString', host: '', port: 0, database: '', user: '', password: '', query: 'SELECT 1', vault: { vaultId, secretId: emptyValueSecretId } },
    })
    assert.equal(emptyConnectionString.statusCode, 200)
    const result = emptyConnectionString.json()
    assert.equal(result.overall, 'error')
    assert.equal(result.steps.at(-1).label, 'Vault resolution failed')
    assert.match(result.steps.at(-1).detail, /empty/)
  })

  it('rejects monitor types that cannot be tested', async () => {
    const response = await runTest({ type: 'webhook', config: {} })
    assert.equal(response.statusCode, 400)
    assert.match(response.json().error, /not supported for monitor type: webhook/)
  })

  it('rejects a request without a body or config with 400', async () => {
    assert.equal((await runTest(undefined)).statusCode, 400)
    assert.equal((await runTest({ type: 'https' })).statusCode, 400)
  })
})
