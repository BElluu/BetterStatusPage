import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { checkHttps } from '../src/workers/https.js'
import { checkPing } from '../src/workers/ping.js'
import { checkDns } from '../src/workers/dns.js'
import { checkSqlServer } from '../src/workers/sqlserver.js'

let lastAuthorization = ''
const httpServer = createHttpServer((req, res) => {
  lastAuthorization = req.headers.authorization ?? ''
  const requestUrl = new URL(req.url ?? '/', 'http://localhost')
  if (requestUrl.pathname === '/cas/v1/tickets' && req.method === 'POST') {
    res.writeHead(201, { Location: `${baseUrl}/cas/tgt` }).end()
    return
  }
  if (requestUrl.pathname === '/cas/tgt' && req.method === 'POST') {
    res.writeHead(200).end('ST-test-ticket')
    return
  }
  if (requestUrl.pathname === '/cas-service') {
    if (requestUrl.searchParams.has('ticket')) res.writeHead(200).end('authenticated service')
    else res.writeHead(302, { Location: `${baseUrl}/cas/login?service=${encodeURIComponent(`${baseUrl}/cas-service`)}` }).end()
    return
  }
  if (req.url === '/token') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"access_token":"oauth-token"}')
    return
  }
  if (req.url === '/protected') {
    res.writeHead(lastAuthorization === 'Bearer oauth-token' || lastAuthorization.startsWith('Basic ') ? 200 : 401)
    res.end('protected')
    return
  }
  if (req.url === '/healthy') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('service is healthy')
    return
  }
  res.writeHead(503)
  res.end('unavailable')
})

let baseUrl = ''

before(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  if (!address || typeof address === 'string') throw new Error('HTTP test server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  httpServer.closeAllConnections()
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => error ? reject(error) : resolve())
  })
})

describe('monitor workers', () => {
  it('reports a healthy HTTP endpoint as up', async () => {
    const result = await checkHttps({
      url: `${baseUrl}/healthy`,
      method: 'GET',
      expectedStatus: 200,
      keyword: 'healthy',
    }, 2_000)

    assert.equal(result.status, 'up')
    assert.equal(result.error, null)
    assert.equal(typeof result.responseMs, 'number')
  })

  it('reports status and keyword mismatches', async () => {
    const badStatus = await checkHttps({
      url: `${baseUrl}/unavailable`,
      method: 'GET',
      expectedStatus: 200,
    }, 2_000)
    assert.equal(badStatus.status, 'down')
    assert.match(badStatus.error ?? '', /Expected HTTP 200, got 503/)

    const badKeyword = await checkHttps({
      url: `${baseUrl}/healthy`,
      method: 'GET',
      expectedStatus: 200,
      keyword: 'missing text',
    }, 2_000)
    assert.equal(badKeyword.status, 'degraded')
    assert.match(badKeyword.error ?? '', /Keyword .* not found/)
  })

  it('returns down instead of crashing when DNS resolution fails', async () => {
    const result = await checkHttps({
      url: 'http://host-that-does-not-exist.invalid',
      method: 'GET',
      expectedStatus: 200,
    }, 2_000)

    assert.equal(result.status, 'down')
    assert.equal(typeof result.responseMs, 'number')
    assert.ok(result.error)
  })

  it('distinguishes an open TCP port from a closed one', async () => {
    const tcpServer = createTcpServer()
    await new Promise<void>((resolve) => tcpServer.listen(0, '127.0.0.1', resolve))
    const address = tcpServer.address()
    if (!address || typeof address === 'string') throw new Error('TCP test server did not bind')

    const open = await checkPing({ host: '127.0.0.1', mode: 'tcp', port: address.port }, 1_000)
    assert.equal(open.status, 'up')

    await new Promise<void>((resolve, reject) => {
      tcpServer.close((error) => error ? reject(error) : resolve())
    })

    const closed = await checkPing({ host: '127.0.0.1', mode: 'tcp', port: address.port }, 1_000)
    assert.equal(closed.status, 'down')
    assert.equal(closed.responseMs, null)
    assert.ok(closed.error)
  })

  it('checks localhost using ICMP mode', async () => {
    const result = await checkPing({ host: '127.0.0.1', mode: 'icmp' }, 2_000)
    assert.equal(result.status, 'up')
    assert.equal(typeof result.responseMs, 'number')
  })

  it('supports Basic and OAuth2 authentication', async () => {
    const basic = await checkHttps({
      url: `${baseUrl}/protected`, method: 'GET', expectedStatus: 200,
      auth: { type: 'basic', basic: { username: 'user', password: 'password' } },
    }, 2_000)
    assert.equal(basic.status, 'up')
    assert.equal(lastAuthorization, `Basic ${Buffer.from('user:password').toString('base64')}`)

    const oauth = await checkHttps({
      url: `${baseUrl}/protected`, method: 'GET', expectedStatus: 200,
      auth: { type: 'oauth2', oauth2: { tokenUrl: `${baseUrl}/token`, clientId: 'client', clientSecret: 'secret' } },
    }, 2_000)
    assert.equal(oauth.status, 'up')
    assert.equal(lastAuthorization, 'Bearer oauth-token')
  })

  it('completes a CAS ticket flow', async () => {
    const result = await checkHttps({
      url: `${baseUrl}/cas-service`, method: 'GET', expectedStatus: 200, keyword: 'authenticated',
      auth: { type: 'cas', cas: { casServerUrl: `${baseUrl}/cas`, username: 'user', password: 'password' } },
    }, 3_000)
    assert.equal(result.status, 'up')
    assert.equal(result.error, null)
  })

  it('returns down for unavailable DNS and SQL Server endpoints', async () => {
    const dns = await checkDns({ hostname: 'example.invalid', recordType: 'A', resolver: '127.0.0.1:1' }, 200)
    assert.equal(dns.status, 'down')
    assert.ok(dns.error)

    const sql = await checkSqlServer({
      host: '127.0.0.1', port: 1, database: 'missing', user: 'user', password: 'password', query: 'SELECT 1',
    }, 200)
    assert.equal(sql.status, 'down')
    assert.ok(sql.error)
  })
})
