import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { CookieJar, followRedirects, requestWithCas, resolveHttpAuth, type HttpFetch, type HttpResponse } from '../src/workers/httpAuth.js'
import { checkHttps } from '../src/workers/https.js'

const response = (status: number, headers: Record<string, string> = {}, setCookie: string[] = []): HttpResponse => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null, getSetCookie: () => setCookie },
})

/** Answers each request in turn and records what was sent. */
function script(...answers: HttpResponse[]) {
  const sent: { url: string; headers: Record<string, string>; body?: string | undefined }[] = []
  const fetch: HttpFetch = async (url, init) => {
    sent.push({ url, headers: init.headers ?? {}, body: init.body })
    return answers[sent.length - 1]!
  }
  return { sent, fetch }
}

const signal = new AbortController().signal

describe('credentials on redirects', () => {
  it('drops credential headers once a redirect leaves the origin, and keeps the harmless ones', async () => {
    const { sent, fetch } = script(response(302, { location: 'https://other.test/x' }), response(200))
    await followRedirects(
      { url: 'https://a.test/', headers: { 'X-Api-Key': 'k', 'X-Auth-Token': 't', Accept: 'application/json' } },
      { Authorization: 'Bearer b' },
      signal,
      fetch,
    )
    assert.deepEqual(Object.keys(sent[0]!.headers).sort(), ['Accept', 'Authorization', 'X-Api-Key', 'X-Auth-Token'])
    assert.deepEqual(sent[1]!.headers, { Accept: 'application/json' })
  })

  it('sends a foreign origin only harmless headers, whatever a credential header is called', async () => {
    const { sent, fetch } = script(response(302, { location: 'https://other.test/' }), response(200))
    await followRedirects(
      { url: 'https://a.test/', headers: { 'X-Jwt-Assertion': 'j', 'X-Hmac': 'h', 'X-Ticket': 't', 'Accept-Language': 'pl', 'User-Agent': 'probe' } },
      {},
      signal,
      fetch,
    )
    assert.deepEqual(sent[1]!.headers, { 'Accept-Language': 'pl', 'User-Agent': 'probe' })
  })

  it('keeps the credentials for a redirect inside the origin', async () => {
    const { sent, fetch } = script(response(302, { location: '/next' }), response(200))
    await followRedirects({ url: 'https://a.test/', headers: { 'X-Api-Key': 'k' } }, {}, signal, fetch)
    assert.equal(sent[1]!.headers['X-Api-Key'], 'k')
  })

  it('does not deliver the body to another origin on a 307, but keeps it inside the origin', async () => {
    const away = script(response(307, { location: 'https://other.test/in' }), response(200))
    await followRedirects({ url: 'https://a.test/', method: 'POST', body: '{"k":1}', headers: { 'Content-Type': 'application/json' } }, {}, signal, away.fetch)
    assert.equal(away.sent[0]!.body, '{"k":1}')
    assert.equal(away.sent[1]!.body, undefined)
    assert.equal(away.sent[1]!.headers['Content-Type'], undefined)

    const inside = script(response(307, { location: '/again' }), response(200))
    await followRedirects({ url: 'https://a.test/', method: 'POST', body: '{"k":1}' }, {}, signal, inside.fetch)
    assert.equal(inside.sent[1]!.body, '{"k":1}')
  })

  it('keeps the credentials when an http URL is upgraded to https on the same host, but not on another port or a downgrade', async () => {
    const headers = { 'X-Api-Key': 'k' }
    const upgrade = script(response(301, { location: 'https://a.test/' }), response(200))
    await followRedirects({ url: 'http://a.test/', headers }, {}, signal, upgrade.fetch)
    assert.equal(upgrade.sent[1]!.headers['X-Api-Key'], 'k')

    const otherPort = script(response(301, { location: 'https://a.test:8443/' }), response(200))
    await followRedirects({ url: 'http://a.test/', headers }, {}, signal, otherPort.fetch)
    assert.equal(otherPort.sent[1]!.headers['X-Api-Key'], undefined)

    const downgrade = script(response(301, { location: 'http://a.test/' }), response(200))
    await followRedirects({ url: 'https://a.test/', headers }, {}, signal, downgrade.fetch)
    assert.equal(downgrade.sent[1]!.headers['X-Api-Key'], undefined)
  })

  it('does not follow a redirect of the OAuth2 token request, so the client secret is sent once', async () => {
    const { sent, fetch } = script(response(307, { location: 'https://evil.test/token' }))
    await assert.rejects(
      resolveHttpAuth({ type: 'oauth2', oauth2: { tokenUrl: 'https://idp.test/token', clientId: 'id', clientSecret: 's3cret' } }, 'https://a.test/', { fetch, signal }),
      /redirected \(HTTP 307\)/,
    )
    assert.equal(sent.length, 1)
  })

  it('a CAS request leaving the endpoint carries neither the configured headers nor the body', async () => {
    const jar = new CookieJar()
    const { sent, fetch } = script(response(200), response(302, { location: 'https://other.test/' }), response(200))
    await requestWithCas(
      { url: 'https://app.test/', method: 'POST', body: 'b', headers: { 'X-Api-Key': 'k' } } as never,
      { headers: {}, url: 'https://app.test/?ticket=ST-1', cas: { serverUrl: 'https://cas.test/cas', tgtUrl: 'https://cas.test/cas/v1/tickets/TGT', jar } },
      { fetch, signal },
    )
    assert.equal(sent[1]!.headers['X-Api-Key'], 'k')
    assert.equal(sent[1]!.body, 'b')
    assert.equal(sent[2]!.url, 'https://other.test/')
    assert.deepEqual(sent[2]!.headers, {})
    assert.equal(sent[2]!.body, undefined)
  })

  it('the scheduled check sends nothing secret to the origin it is redirected to', async () => {
    let received: IncomingHttpHeaders | undefined
    let receivedBody = ''
    const target = createServer((req, res) => {
      received = req.headers
      req.on('data', (c) => { receivedBody += c })
      req.on('end', () => res.end('ok'))
    })
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
    const entry = createServer((_req, res) => {
      res.writeHead(307, { location: `http://localhost:${(target.address() as AddressInfo).port}/` })
      res.end()
    })
    await new Promise<void>((r) => entry.listen(0, '127.0.0.1', r))
    try {
      const url = `http://127.0.0.1:${(entry.address() as AddressInfo).port}/`
      const result = await checkHttps({
        url, method: 'POST', body: 'secret-body', headers: { 'X-Api-Key': 'k', 'Content-Type': 'text/plain' },
        auth: { type: 'basic', basic: { username: 'u', password: 'p' } },
      } as never, 5000)
      assert.equal(result.status, 'up', result.error ?? '')
      assert.equal(received?.['x-api-key'], undefined)
      assert.equal(received?.['authorization'], undefined)
      assert.equal(receivedBody, '')
    } finally {
      entry.close()
      target.close()
    }
  })
})

describe('cookie scoping', () => {
  it('sends a cookie to the host that set it, whatever the port or scheme, to its Domain subdomains, and Secure ones only over https', () => {
    const jar = new CookieJar()
    jar.collect(response(200, {}, ['proxy=1; Path=/', 'wide=2; Domain=example.com; Path=/', 'tls=3; Secure']), 'http://app.example.com:8080/')
    assert.deepEqual(jar.header('https://app.example.com/'), { Cookie: 'proxy=1; wide=2; tls=3' })
    assert.deepEqual(jar.header('http://app.example.com/'), { Cookie: 'proxy=1; wide=2' })
    assert.deepEqual(jar.header('https://other.example.com/'), { Cookie: 'wide=2' })
    assert.deepEqual(jar.header('https://example.org/'), {})
  })

  it('ignores a Domain the setting host does not belong to, and a bare top-level one', () => {
    const jar = new CookieJar()
    jar.collect(response(200, {}, ['a=1; Domain=victim.test', 'b=2; Domain=com']), 'https://evil.test/')
    assert.deepEqual(jar.header('https://victim.test/'), {})
    assert.deepEqual(jar.header('https://other.com/'), {})
    assert.deepEqual(jar.header('https://evil.test/'), { Cookie: 'a=1; b=2' })
  })

  it('lists a cookie name once', () => {
    const jar = new CookieJar()
    jar.collect(response(200, {}, ['sid=1']), 'https://a.test/')
    jar.collect(response(200, {}, ['sid=2']), 'https://b.test/')
    assert.deepEqual(jar.names(), ['sid'])
    assert.equal(jar.size, 1)
  })
})
