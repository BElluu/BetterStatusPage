import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { connect, type AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, it } from 'node:test'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url))
const listen = (server: Server) => new Promise<number>((done) => server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)))
const close = (server: Server) => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections() })
const metadata = 'http://169.254.169.254/latest/meta-data/'
const config = { method: 'GET', expectedStatus: 200 } as const

interface Seen { requests: string[]; tunnels: string[]; proxyAuth: (string | undefined)[] }

// A proxy that records what it is asked: a plain request carries the absolute URL of the target, https targets are
// reached with CONNECT. `refuseTunnels` answers CONNECT with 407, `redirect` is a URL the proxy answers with a redirect to the metadata service.
function makeProxy(seen: Seen, state: { refuseTunnels: boolean; redirect: string }): Server {
  const proxy = createServer((req, res) => {
    seen.requests.push(req.url ?? '')
    if (req.url === state.redirect) return void res.writeHead(302, { location: metadata }).end()
    res.end('via proxy')
  })
  proxy.on('connect', (req: IncomingMessage, client, head) => {
    seen.tunnels.push(req.url ?? '')
    seen.proxyAuth.push(req.headers['proxy-authorization'])
    if (state.refuseTunnels) return void client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
    const [host, port] = (req.url ?? '').split(':')
    const upstream = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
  })
  return proxy
}

describe('HTTP checks through an outbound proxy', () => {
  const viaHttp: Seen = { requests: [], tunnels: [], proxyAuth: [] }
  const viaHttps: Seen = { requests: [], tunnels: [], proxyAuth: [] }
  const redirectUrl = 'http://redirect.example/'
  const state = { refuseTunnels: false, redirect: redirectUrl }
  const targetHeaders: IncomingMessage['headers'][] = []
  const target = createServer((_req, res) => res.end('ok'))
  const tlsTarget = createTlsServer({ key: fixture('self-signed-key.pem'), cert: fixture('self-signed-cert.pem') }, (req, res) => {
    targetHeaders.push(req.headers)
    res.end('ok')
  })
  const proxyA = makeProxy(viaHttp, state)
  const proxyB = makeProxy(viaHttps, state)
  let targetUrl = ''
  let tlsUrl = ''
  let checkHttps: typeof import('../src/workers/https.js').checkHttps
  let testHttps: typeof import('../src/workers/testRunner.js').testHttps

  before(async () => {
    targetUrl = `http://127.0.0.1:${await listen(target)}/`
    tlsUrl = `https://127.0.0.1:${await listen(tlsTarget)}/`
    // http and https targets use different proxies, and the https one is given credentials.
    process.env['HTTP_PROXY'] = `http://127.0.0.1:${await listen(proxyA)}`
    process.env['HTTPS_PROXY'] = `http://user:s3cret@127.0.0.1:${await listen(proxyB)}`
    // The agents read these when they are created, so the workers are loaded after they are set.
    ;({ checkHttps } = await import('../src/workers/https.js'))
    ;({ testHttps } = await import('../src/workers/testRunner.js'))
  })

  beforeEach(() => {
    for (const s of [viaHttp, viaHttps]) { s.requests.length = 0; s.tunnels.length = 0; s.proxyAuth.length = 0 }
    targetHeaders.length = 0
    state.refuseTunnels = false
    delete process.env['NO_PROXY']
    delete process.env['MONITOR_ALLOW_METADATA']
  })

  after(async () => {
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'MONITOR_ALLOW_METADATA']) delete process.env[name]
    await Promise.all([target, tlsTarget, proxyA, proxyB].map(close))
  })

  it('sends an http target to HTTP_PROXY as an ordinary request, not a tunnel', async () => {
    const result = await checkHttps({ url: targetUrl, ...config, keyword: 'via proxy' }, 5000)
    assert.equal(result.status, 'up', result.error ?? '')
    assert.deepEqual(viaHttp.requests, [targetUrl])
    assert.deepEqual(viaHttp.tunnels, [])
    assert.deepEqual(viaHttps.tunnels, [])
  })

  it('tunnels an https target through HTTPS_PROXY, with ignoreTls only for the certificate of the target', async () => {
    const strict = await checkHttps({ url: tlsUrl, ...config }, 5000)
    assert.equal(strict.status, 'down')
    assert.equal(targetHeaders.length, 0)

    const lenient = await checkHttps({ url: tlsUrl, ...config, keyword: 'ok', ignoreTls: true }, 5000)
    assert.equal(lenient.status, 'up', lenient.error ?? '')
    assert.equal(targetHeaders.length, 1)
    assert.deepEqual(viaHttps.tunnels, [new URL(tlsUrl).host, new URL(tlsUrl).host])
    assert.deepEqual(viaHttp.tunnels, [])
  })

  it('gives the proxy the credentials of its URL and never sends them to the target', async () => {
    await checkHttps({ url: tlsUrl, ...config, ignoreTls: true }, 5000)
    assert.deepEqual(viaHttps.proxyAuth, [`Basic ${Buffer.from('user:s3cret').toString('base64')}`])
    assert.equal(targetHeaders[0]?.['proxy-authorization'], undefined)
  })

  it('reports why the proxy refused instead of "fetch failed", without its credentials', async () => {
    state.refuseTunnels = true
    // An open tunnel is reused, so the refusal is asked of an origin no check has used.
    const result = await checkHttps({ url: tlsUrl.replace('127.0.0.1', 'localhost'), ...config, ignoreTls: true }, 5000)
    assert.equal(result.status, 'down')
    assert.match(result.error ?? '', /407/)
    assert.doesNotMatch(result.error ?? '', /s3cret/)
  })

  it('serves the Test button through the proxy as well', async () => {
    const http = await testHttps({ url: targetUrl, ...config, keyword: 'via proxy' }, 5000)
    assert.equal(http.overall, 'ok')
    assert.deepEqual(viaHttp.requests, [targetUrl])

    const strict = await testHttps({ url: tlsUrl, ...config }, 5000)
    assert.equal(strict.overall, 'error')
    assert.equal(targetHeaders.length, 0)
    const lenient = await testHttps({ url: tlsUrl, ...config, ignoreTls: true }, 5000)
    assert.equal(lenient.overall, 'ok')
    assert.equal(targetHeaders.length, 1)
    assert.ok(viaHttps.tunnels.length >= 2)
  })

  it('skips the proxy for a host in NO_PROXY', async () => {
    process.env['NO_PROXY'] = '127.0.0.1'
    const result = await checkHttps({ url: targetUrl, ...config, keyword: 'ok' }, 5000)
    assert.equal(result.status, 'up', result.error ?? '')
    assert.deepEqual(viaHttp.requests, [])
  })

  it('refuses a metadata address, which the proxy would otherwise connect to', async () => {
    for (const url of [metadata, 'https://169.254.169.254/', 'http://metadata/', 'http://instance-data.ec2.internal/']) {
      const result = await checkHttps({ url, ...config }, 5000)
      assert.equal(result.status, 'down', url)
      assert.match(result.error ?? '', /Refusing to connect/, url)
    }
    assert.deepEqual(viaHttp.requests, [])
    assert.deepEqual(viaHttps.tunnels, [])
  })

  it('refuses a redirect to a metadata address before it is requested through the proxy', async () => {
    const result = await checkHttps({ url: redirectUrl, ...config }, 5000)
    assert.equal(result.status, 'down')
    assert.match(result.error ?? '', /Refusing to connect/)
    assert.deepEqual(viaHttp.requests, [redirectUrl])
  })

  it('refuses a metadata address that NO_PROXY sends past the proxy', async () => {
    process.env['NO_PROXY'] = '169.254.169.254'
    const result = await checkHttps({ url: metadata, ...config }, 5000)
    assert.equal(result.status, 'down')
    assert.match(result.error ?? '', /Refusing to connect/)
    assert.deepEqual(viaHttp.requests, [])
  })

  it('lets a metadata address through the proxy with MONITOR_ALLOW_METADATA=true', async () => {
    process.env['MONITOR_ALLOW_METADATA'] = 'true'
    const result = await checkHttps({ url: metadata, ...config }, 5000)
    assert.equal(result.status, 'up', result.error ?? '')
    assert.deepEqual(viaHttp.requests, [metadata])
  })
})
