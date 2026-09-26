import assert from 'node:assert/strict'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { createServer as createHttpServer, type IncomingMessage } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { after, before, describe, it } from 'node:test'
import type { HttpsConfig } from '@bsp/shared'
import { checkHttps } from '../src/workers/https.js'
import { testDns, testHttps, testPing, testSqlServer, type TestResult } from '../src/workers/testRunner.js'

const SESSION_SECRET = 'session-cookie-value-never-shown'
const casServiceRequests: string[] = []
let lastAuthorization = ''
let lastCustomHeader = ''

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
  })
}

function hasCookie(req: IncomingMessage, name: string): boolean {
  return (req.headers.cookie ?? '').split(';').some((part) => part.trim().startsWith(`${name}=`))
}

const httpServer = createHttpServer(async (req, res) => {
  lastAuthorization = req.headers.authorization ?? ''
  lastCustomHeader = String(req.headers['x-probe'] ?? '')
  const url = new URL(req.url ?? '/', 'http://localhost')
  const body = await readBody(req)

  switch (url.pathname) {
    case '/healthy':
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('service is healthy')
      return
    case '/protected': {
      const basic = `Basic ${Buffer.from('user:password').toString('base64')}`
      res.writeHead(lastAuthorization === basic || lastAuthorization === 'Bearer oauth-token' ? 200 : 401).end('protected')
      return
    }
    case '/token': {
      const params = new URLSearchParams(body)
      if (params.get('client_id') !== 'client' || params.get('client_secret') !== 'secret') {
        res.writeHead(401).end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ access_token: 'oauth-token', token_type: 'Bearer', expires_in: 3600 }))
      return
    }
    case '/token-without-access-token':
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
      return
    case '/slow':
      setTimeout(() => { if (!res.writableEnded) res.writeHead(200).end('late') }, 1_500)
      return
    case '/redirect':
      res.writeHead(302, { Location: '/healthy' }).end()
      return
    case '/redirect-to':
      res.writeHead(302, { Location: url.searchParams.get('target') ?? '/healthy' }).end()
      return
    case '/redirect-loop':
      res.writeHead(302, { Location: '/redirect-loop' }).end()
      return
    case '/post-then-see-other':
      res.writeHead(303, { Location: '/get-only' }).end()
      return
    case '/get-only':
      res.writeHead(req.method === 'GET' ? 200 : 405).end('get only')
      return

    // ── CAS server ───────────────────────────────────────────────────────────
    case '/cas/v1/tickets': {
      const params = new URLSearchParams(body)
      if (req.method !== 'POST' || params.get('username') !== 'user' || params.get('password') !== 'password') {
        res.writeHead(401).end()
        return
      }
      res.writeHead(201, { Location: `${baseUrl}/cas/tgt` }).end()
      return
    }
    case '/cas/tgt':
      casServiceRequests.push(new URLSearchParams(body).get('service') ?? '')
      res.writeHead(200).end('ST-1-test-service-ticket')
      return

    // Single CAS layer: the ticket opens a session cookie, the cookie then grants access.
    case '/cas-service':
      if (url.searchParams.has('ticket')) {
        res.writeHead(200, { 'Set-Cookie': `session=${SESSION_SECRET}; HttpOnly` }).end('ticket accepted')
      } else if (hasCookie(req, 'session')) {
        res.writeHead(200).end('authenticated service')
      } else {
        res.writeHead(302, { Location: `${baseUrl}/cas/login?service=${encodeURIComponent(`${baseUrl}/cas-service`)}` }).end()
      }
      return

    // Two CAS layers: a proxy cookie first, then the application asks CAS for its own ticket.
    case '/cas-two':
      if (url.searchParams.has('ticket')) {
        res.writeHead(302, { 'Set-Cookie': 'proxy=ok', Location: '/cas-two' }).end()
      } else if (hasCookie(req, 'proxy')) {
        res.writeHead(302, { Location: `${baseUrl}/cas/login?service=${encodeURIComponent(`${baseUrl}/cas-two-app`)}` }).end()
      } else {
        res.writeHead(302, { Location: `${baseUrl}/cas/login?service=${encodeURIComponent(`${baseUrl}/cas-two`)}` }).end()
      }
      return
    case '/cas-two-app':
      if (hasCookie(req, 'proxy') && url.searchParams.has('ticket')) res.writeHead(200).end('app authenticated')
      else res.writeHead(401).end()
      return
  }
  res.writeHead(503).end('unavailable')
})

// Minimal UDP DNS responder: answers A/TXT for known names, NXDOMAIN otherwise, and stays silent for one name.
const dnsServer: UdpSocket = createSocket('udp4')
dnsServer.on('message', (query, remote) => {
  let offset = 12
  const labels: string[] = []
  while (query[offset] !== 0) {
    const length = query[offset]!
    labels.push(query.subarray(offset + 1, offset + 1 + length).toString())
    offset += length + 1
  }
  const questionEnd = offset + 5
  const qtype = query.readUInt16BE(offset + 1)
  const name = labels.join('.')
  if (name === 'silent.test') return

  let answer: Buffer | null = null
  if (name === 'svc.test' && qtype === 1) answer = Buffer.from([10, 1, 2, 3])
  if (name === 'svc.test' && qtype === 16) {
    const text = Buffer.from('v=verify-token')
    answer = Buffer.concat([Buffer.from([text.length]), text])
  }

  const header = Buffer.alloc(12)
  query.copy(header, 0, 0, 2)
  header.writeUInt16BE(answer ? 0x8180 : 0x8183, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(answer ? 1 : 0, 6)
  const parts = [header, query.subarray(12, questionEnd)]
  if (answer) {
    const record = Buffer.alloc(12)
    record.writeUInt16BE(0xc00c, 0)
    record.writeUInt16BE(qtype, 2)
    record.writeUInt16BE(1, 4)
    record.writeUInt32BE(60, 6)
    record.writeUInt16BE(answer.length, 10)
    parts.push(record, answer)
  }
  dnsServer.send(Buffer.concat(parts), remote.port, remote.address)
})

let baseUrl = ''
let dnsResolver = ''
let closedPort = 0

before(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  if (!address || typeof address === 'string') throw new Error('HTTP test server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`

  await new Promise<void>((resolve) => dnsServer.bind(0, '127.0.0.1', resolve))
  dnsResolver = `127.0.0.1:${dnsServer.address().port}`

  const probe = createTcpServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const probeAddress = probe.address()
  if (!probeAddress || typeof probeAddress === 'string') throw new Error('TCP probe did not bind')
  closedPort = probeAddress.port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
})

after(async () => {
  httpServer.closeAllConnections()
  await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()))
  await new Promise<void>((resolve) => dnsServer.close(() => resolve()))
})

function labels(result: TestResult): string[] {
  return result.steps.map((step) => step.label)
}

function step(result: TestResult, pattern: RegExp) {
  const found = result.steps.find((s) => pattern.test(s.label))
  assert.ok(found, `expected a step matching ${pattern}, got: ${labels(result).join(' | ')}`)
  return found
}

function lastStep(result: TestResult) {
  return result.steps.at(-1)!
}

describe('monitor test runner: HTTPS', () => {
  it('passes a healthy endpoint and reports the keyword without exposing the body', async () => {
    const result = await testHttps({
      url: `${baseUrl}/healthy`, method: 'GET', expectedStatus: 200, keyword: 'healthy',
      headers: { 'X-Probe': 'custom-header' },
    }, 2_000)

    assert.equal(result.overall, 'ok')
    assert.equal(step(result, /^Authorization: none$/).status, 'info')
    assert.equal(step(result, /^Response: HTTP 200$/).status, 'ok')
    assert.equal(step(result, /^Keyword "healthy" found/).status, 'ok')
    assert.match(step(result, /^Response body$/).detail ?? '', /bytes \(content omitted\)/)
    assert.doesNotMatch(JSON.stringify(result), /service is healthy/)
    assert.equal(lastCustomHeader, 'custom-header')
    assert.equal(typeof result.totalMs, 'number')
  })

  it('fails on an unexpected status code', async () => {
    const result = await testHttps({ url: `${baseUrl}/unavailable`, method: 'GET', expectedStatus: 200 }, 2_000)
    assert.equal(result.overall, 'error')
    assert.equal(lastStep(result).label, 'Response: HTTP 503')
    assert.equal(lastStep(result).status, 'error')
    assert.match(lastStep(result).detail ?? '', /Expected HTTP 200/)
  })

  it('fails when the keyword is missing', async () => {
    const result = await testHttps({ url: `${baseUrl}/healthy`, method: 'GET', expectedStatus: 200, keyword: 'absent' }, 2_000)
    assert.equal(result.overall, 'error')
    assert.equal(lastStep(result).label, 'Keyword "absent" not found in response')
    assert.equal(lastStep(result).status, 'error')
  })

  it('follows redirects and gives up on a redirect loop', async () => {
    const redirected = await testHttps({ url: `${baseUrl}/redirect`, method: 'GET', expectedStatus: 200, keyword: 'healthy' }, 2_000)
    assert.equal(redirected.overall, 'ok')
    step(redirected, /^→ 302 .*\/healthy$/)

    const loop = await testHttps({ url: `${baseUrl}/redirect-loop`, method: 'GET', expectedStatus: 200 }, 2_000)
    assert.equal(loop.overall, 'error')
    assert.equal(lastStep(loop).label, 'Response: HTTP 302')
  })

  it('reports a timeout as a failed request', async () => {
    const started = Date.now()
    const result = await testHttps({ url: `${baseUrl}/slow`, method: 'GET', expectedStatus: 200 }, 150)
    assert.equal(result.overall, 'error')
    assert.equal(lastStep(result).label, 'Request failed')
    assert.ok(Date.now() - started < 1_400, 'timeout must abort before the server answers')
  })

  it('reports a refused connection as a failed request', async () => {
    const result = await testHttps({ url: `http://127.0.0.1:${closedPort}/`, method: 'GET', expectedStatus: 200 }, 1_000)
    assert.equal(result.overall, 'error')
    assert.equal(lastStep(result).label, 'Request failed')
    assert.ok(lastStep(result).detail)
  })

  it('sends Basic credentials without echoing the password', async () => {
    const result = await testHttps({
      url: `${baseUrl}/protected`, method: 'GET', expectedStatus: 200,
      auth: { type: 'basic', basic: { username: 'user', password: 'password' } },
    }, 2_000)
    assert.equal(result.overall, 'ok')
    assert.equal(step(result, /^Basic Auth: using direct credentials$/).detail, 'User: user')
    assert.equal(lastAuthorization, `Basic ${Buffer.from('user:password').toString('base64')}`)
    assert.doesNotMatch(JSON.stringify(result), /password/)
  })

  it('labels the request with its method', async () => {
    const result = await testHttps({ url: `${baseUrl}/healthy`, method: 'POST', body: 'x=1', expectedStatus: 200 }, 2_000)
    step(result, new RegExp(`^POST ${baseUrl}/healthy$`))
  })

  it('does not forward credentials when a redirect leaves the origin', async () => {
    const seen: Array<{ authorization: string | undefined; probe: string | undefined }> = []
    const other = createHttpServer((req, res) => {
      seen.push({ authorization: req.headers.authorization, probe: req.headers['x-probe'] as string | undefined })
      res.writeHead(200).end('elsewhere')
    })
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve))
    const address = other.address()
    if (!address || typeof address === 'string') throw new Error('HTTP test server did not bind')
    try {
      const target = encodeURIComponent(`http://127.0.0.1:${address.port}/landing`)
      const result = await testHttps({
        url: `${baseUrl}/redirect-to?target=${target}`, method: 'GET', expectedStatus: 200,
        headers: { 'X-Probe': 'kept', Authorization: 'Bearer custom-header-token' },
        auth: { type: 'basic', basic: { username: 'user', password: 'password' } },
      }, 2_000)
      assert.equal(result.overall, 'ok', labels(result).join(' | '))
      assert.equal(lastAuthorization, `Basic ${Buffer.from('user:password').toString('base64')}`)
      assert.deepEqual(seen, [{ authorization: undefined, probe: 'kept' }])
    } finally {
      other.closeAllConnections()
      await new Promise<void>((resolve) => other.close(() => resolve()))
    }
  })

  it('obtains an OAuth2 token and uses it as a bearer token', async () => {
    const result = await testHttps({
      url: `${baseUrl}/protected`, method: 'GET', expectedStatus: 200,
      auth: { type: 'oauth2', oauth2: { tokenUrl: `${baseUrl}/token`, clientId: 'client', clientSecret: 'secret', scope: 'read' } },
    }, 2_000)
    assert.equal(result.overall, 'ok')
    const tokenStep = step(result, /^OAuth2: token obtained from /)
    assert.equal(tokenStep.status, 'ok')
    assert.match(tokenStep.detail ?? '', /expires in 3600s/)
    assert.equal(lastAuthorization, 'Bearer oauth-token')
    assert.doesNotMatch(JSON.stringify(result), /oauth-token/)
  })

  it('stops before the request when OAuth2 cannot produce a token', async () => {
    const missingUrl = await testHttps({
      url: `${baseUrl}/protected`, method: 'GET', expectedStatus: 200,
      auth: { type: 'oauth2', oauth2: { tokenUrl: '', clientId: 'client', clientSecret: 'secret' } },
    }, 2_000)
    assert.equal(missingUrl.overall, 'error')
    assert.equal(lastStep(missingUrl).label, 'OAuth2: Token URL is missing')

    const rejected = await testHttps({
      url: `${baseUrl}/protected`, method: 'GET', expectedStatus: 200,
      auth: { type: 'oauth2', oauth2: { tokenUrl: `${baseUrl}/token`, clientId: 'client', clientSecret: 'wrong' } },
    }, 2_000)
    assert.equal(rejected.overall, 'error')
    assert.match(lastStep(rejected).label, /^OAuth2: token request to .* failed$/)
    assert.match(lastStep(rejected).detail ?? '', /HTTP 401/)

    const noToken = await testHttps({
      url: `${baseUrl}/protected`, method: 'GET', expectedStatus: 200,
      auth: { type: 'oauth2', oauth2: { tokenUrl: `${baseUrl}/token-without-access-token`, clientId: 'client', clientSecret: 'secret' } },
    }, 2_000)
    assert.equal(noToken.overall, 'error')
    assert.match(lastStep(noToken).detail ?? '', /missing access_token/)
    assert.equal(labels(noToken).some((label) => label.startsWith('GET ')), false)
  })

  it('completes a CAS flow: probe, service ticket, session cookie', async () => {
    casServiceRequests.length = 0
    const result = await testHttps({
      url: `${baseUrl}/cas-service`, method: 'GET', expectedStatus: 200, keyword: 'authenticated',
      auth: { type: 'cas', cas: { casServerUrl: `${baseUrl}/cas`, username: 'user', password: 'password' } },
    }, 3_000)

    assert.equal(result.overall, 'ok', labels(result).join(' | '))
    step(result, /^CAS: TGT obtained from /)
    assert.equal(step(result, /^CAS: effective service URL discovered$/).detail, `${baseUrl}/cas-service`)
    step(result, /^CAS: service ticket obtained$/)
    const registered = step(result, /^CAS: ticket registered → 200$/)
    assert.deepEqual(registered.cookies, { session: '[redacted]' })
    assert.deepEqual(casServiceRequests, [`${baseUrl}/cas-service`])
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SESSION_SECRET))
  })

  it('requests an application-level CAS ticket when the app redirects to CAS again', async () => {
    casServiceRequests.length = 0
    const result = await testHttps({
      url: `${baseUrl}/cas-two`, method: 'GET', expectedStatus: 200,
      auth: { type: 'cas', cas: { casServerUrl: `${baseUrl}/cas`, username: 'user', password: 'password' } },
    }, 3_000)

    assert.equal(result.overall, 'ok', labels(result).join(' | '))
    step(result, /^CAS: app-level ticket obtained/)
    assert.deepEqual(casServiceRequests, [`${baseUrl}/cas-two`, `${baseUrl}/cas-two-app`])
  })

  it('fails the CAS flow on bad credentials or a missing server URL', async () => {
    const badCredentials = await testHttps({
      url: `${baseUrl}/cas-service`, method: 'GET', expectedStatus: 200,
      auth: { type: 'cas', cas: { casServerUrl: `${baseUrl}/cas`, username: 'user', password: 'wrong' } },
    }, 2_000)
    assert.equal(badCredentials.overall, 'error')
    assert.equal(lastStep(badCredentials).label, 'CAS: TGT request failed')
    assert.match(lastStep(badCredentials).detail ?? '', /HTTP 401/)

    const missingServer = await testHttps({
      url: `${baseUrl}/cas-service`, method: 'GET', expectedStatus: 200,
      auth: { type: 'cas', cas: { casServerUrl: '', username: 'user', password: 'password' } },
    }, 2_000)
    assert.equal(missingServer.overall, 'error')
    assert.equal(lastStep(missingServer).label, 'CAS: Server URL is missing')
  })
})

describe('monitor test runner: parity with the scheduled HTTPS check', () => {
  // A scheduled check is healthy only when it is "up"; "degraded" and "down" must both fail the test button.
  const cases: Array<[string, HttpsConfig, number]> = [
    ['healthy endpoint', { url: '/healthy', method: 'GET', expectedStatus: 200, keyword: 'healthy' }, 2_000],
    ['status mismatch', { url: '/unavailable', method: 'GET', expectedStatus: 200 }, 2_000],
    ['keyword mismatch', { url: '/healthy', method: 'GET', expectedStatus: 200, keyword: 'absent' }, 2_000],
    ['followed redirect', { url: '/redirect', method: 'GET', expectedStatus: 200 }, 2_000],
    ['redirect loop', { url: '/redirect-loop', method: 'GET', expectedStatus: 200 }, 2_000],
    ['timeout', { url: '/slow', method: 'GET', expectedStatus: 200 }, 150],
    ['basic auth', { url: '/protected', method: 'GET', expectedStatus: 200, auth: { type: 'basic', basic: { username: 'user', password: 'password' } } }, 2_000],
    ['wrong basic auth', { url: '/protected', method: 'GET', expectedStatus: 200, auth: { type: 'basic', basic: { username: 'user', password: 'nope' } } }, 2_000],
    ['CAS', { url: '/cas-service', method: 'GET', expectedStatus: 200, keyword: 'authenticated', auth: { type: 'cas', cas: { casServerUrl: '/cas', username: 'user', password: 'password' } } }, 3_000],
    ['two-layer CAS', { url: '/cas-two', method: 'GET', expectedStatus: 200, auth: { type: 'cas', cas: { casServerUrl: '/cas', username: 'user', password: 'password' } } }, 3_000],
  ]

  function absolute(config: HttpsConfig): HttpsConfig {
    const cas = config.auth?.cas
    return {
      ...config,
      url: `${baseUrl}${config.url}`,
      ...(cas ? { auth: { type: 'cas', cas: { ...cas, casServerUrl: `${baseUrl}${cas.casServerUrl}` } } } : {}),
    }
  }

  for (const [name, config, timeoutMs] of cases) {
    it(`agrees on: ${name}`, async () => {
      const [scheduled, tested] = await Promise.all([
        checkHttps(absolute(config), timeoutMs),
        testHttps(absolute(config), timeoutMs),
      ])
      assert.equal(tested.overall === 'ok', scheduled.status === 'up',
        `checkHttps=${scheduled.status} (${scheduled.error}) but testHttps=${tested.overall} (${labels(tested).join(' | ')})`)
    })
  }

  // checkHttps relies on fetch, which turns POST into GET on 303; testHttps follows redirects by
  // hand and must do the same, or the Test button fails an endpoint the scheduler sees as up.
  it('agrees on: POST answered with 303 See Other', async () => {
    const config: HttpsConfig = { url: `${baseUrl}/post-then-see-other`, method: 'POST', body: 'x=1', expectedStatus: 200 }
    const [scheduled, tested] = await Promise.all([checkHttps(config, 2_000), testHttps(config, 2_000)])
    assert.equal(scheduled.status, 'up')
    assert.equal(tested.overall, 'ok', labels(tested).join(' | '))
  })
})

describe('monitor test runner: TCP ping', () => {
  it('succeeds on an open port and fails on a closed one', async () => {
    const server = createTcpServer((socket) => socket.destroy())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('TCP server did not bind')

    const open = await testPing({ host: '127.0.0.1', mode: 'tcp', port: address.port }, 1_000)
    assert.equal(open.overall, 'ok')
    assert.equal(open.steps[0]!.label, `TCP connect to 127.0.0.1:${address.port}`)
    assert.equal(open.steps[0]!.status, 'ok')
    await new Promise<void>((resolve) => server.close(() => resolve()))

    const closed = await testPing({ host: '127.0.0.1', mode: 'tcp', port: closedPort }, 1_000)
    assert.equal(closed.overall, 'error')
    assert.equal(closed.steps[0]!.label, `TCP connect to 127.0.0.1:${closedPort} failed`)
    assert.ok(closed.steps[0]!.detail)
  })
})

describe('monitor test runner: DNS', () => {
  it('resolves records through a custom resolver and checks the expected value', async () => {
    const a = await testDns({ hostname: 'svc.test', recordType: 'A', resolver: dnsResolver, expectedValue: '10.1.2.3' }, 2_000)
    assert.equal(a.overall, 'ok', labels(a).join(' | '))
    assert.equal(step(a, /^Custom resolver: /).status, 'info')
    assert.equal(step(a, /^DNS A for svc\.test$/).detail, '10.1.2.3')
    assert.equal(step(a, /^Expected value "10\.1\.2\.3" found$/).status, 'ok')

    const txt = await testDns({ hostname: 'svc.test', recordType: 'TXT', resolver: dnsResolver, expectedValue: 'verify-token' }, 2_000)
    assert.equal(txt.overall, 'ok', labels(txt).join(' | '))
  })

  it('fails when the expected value is absent', async () => {
    const result = await testDns({ hostname: 'svc.test', recordType: 'A', resolver: dnsResolver, expectedValue: '192.0.2.1' }, 2_000)
    assert.equal(result.overall, 'error')
    assert.equal(lastStep(result).label, 'Expected value "192.0.2.1" not found')
    assert.match(lastStep(result).detail ?? '', /10\.1\.2\.3/)
  })

  it('fails on NXDOMAIN, an unreachable resolver and a timeout', async () => {
    const nxdomain = await testDns({ hostname: 'missing.test', recordType: 'A', resolver: dnsResolver }, 2_000)
    assert.equal(nxdomain.overall, 'error')
    assert.equal(lastStep(nxdomain).label, 'DNS A query for missing.test failed')
    assert.match(lastStep(nxdomain).detail ?? '', /ENOTFOUND/)

    const unreachable = await testDns({ hostname: 'svc.test', recordType: 'A', resolver: '127.0.0.1:1' }, 500)
    assert.equal(unreachable.overall, 'error')

    const silent = await testDns({ hostname: 'silent.test', recordType: 'A', resolver: dnsResolver }, 200)
    assert.equal(silent.overall, 'error')
    assert.equal(lastStep(silent).detail, 'DNS query timed out')
  })
})

describe('monitor test runner: SQL Server', () => {
  it('reports a connection failure for an unreachable server', async () => {
    const result = await testSqlServer({
      host: '127.0.0.1', port: closedPort, database: 'missing', user: 'sa', password: 'secret-password', query: 'SELECT 1',
    }, 500)
    assert.equal(result.overall, 'error')
    assert.equal(step(result, /^Using direct credentials$/).detail, 'User: sa')
    assert.equal(lastStep(result).label, `Connection to 127.0.0.1:${closedPort} failed`)
    assert.doesNotMatch(JSON.stringify(result), /secret-password/)
  })

  it('requires a Vault secret in connection-string mode', async () => {
    const result = await testSqlServer({
      mode: 'connectionString', host: '', port: 0, database: '', user: '', password: '', query: 'SELECT 1',
    }, 500)
    assert.equal(result.overall, 'error')
    assert.equal(lastStep(result).label, 'Connection string: no Vault secret configured')
  })
})
