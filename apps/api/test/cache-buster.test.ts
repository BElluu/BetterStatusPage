import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { CACHE_BUSTER_PARAM } from '@bsp/shared'
import { parseNewMonitor } from '../src/services/monitorInput.js'
import { requestUrl } from '../src/workers/httpAuth.js'
import { checkHttps } from '../src/workers/https.js'
import { testHttps } from '../src/workers/testRunner.js'

const seen: { method: string; url: string }[] = []
let server: Server
let base = ''

before(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '' })
    if (req.url?.startsWith('/redirect')) { res.writeHead(302, { location: '/landing?x=1' }); res.end(); return }
    res.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })

const param = (url: string) => new URL(url, 'http://x').searchParams.get(CACHE_BUSTER_PARAM)

describe('cache buster', () => {
  it('adds a fresh random parameter to a GET or HEAD URL and keeps the rest of it', () => {
    const first = requestUrl({ cacheBuster: true }, 'https://example.test/health?a=1#top')
    const second = requestUrl({ cacheBuster: true, method: 'head' }, 'https://example.test/health?a=1#top')
    assert.match(param(first) ?? '', /^[0-9a-f]{16}$/)
    assert.notEqual(param(first), param(second))
    assert.equal(new URL(first).searchParams.get('a'), '1')
    assert.equal(new URL(first).hash, '#top')
  })

  it('leaves the URL alone when off, for POST, and for a URL that cannot be parsed', () => {
    assert.equal(requestUrl({}, 'https://example.test/'), 'https://example.test/')
    assert.equal(requestUrl({ cacheBuster: false }, 'https://example.test/'), 'https://example.test/')
    assert.equal(requestUrl({ cacheBuster: true, method: 'POST' }, 'https://example.test/'), 'https://example.test/')
    assert.equal(requestUrl({ cacheBuster: true }, 'not a url'), 'not a url')
  })

  it('replaces a parameter of the same name instead of repeating it', () => {
    const url = requestUrl({ cacheBuster: true }, `https://example.test/?${CACHE_BUSTER_PARAM}=old`)
    assert.equal(new URL(url).searchParams.getAll(CACHE_BUSTER_PARAM).length, 1)
    assert.notEqual(param(url), 'old')
  })

  it('sends a different parameter with every check, only on the first request', async () => {
    seen.length = 0
    const config = { url: `${base}/redirect`, method: 'GET' as const, expectedStatus: 200, cacheBuster: true }
    assert.equal((await checkHttps(config, 3_000)).status, 'up')
    assert.equal((await checkHttps(config, 3_000)).status, 'up')
    const firsts = seen.filter((r) => r.url.startsWith('/redirect'))
    assert.equal(firsts.length, 2)
    assert.ok(firsts.every((r) => /^[0-9a-f]{16}$/.test(param(r.url) ?? '')))
    assert.notEqual(param(firsts[0]!.url), param(firsts[1]!.url))
    // The redirect target is the server's own address and is followed as given.
    assert.deepEqual(seen.filter((r) => r.url.startsWith('/landing')).map((r) => r.url), ['/landing?x=1', '/landing?x=1'])
  })

  it('sends the plain URL when it is off', async () => {
    seen.length = 0
    await checkHttps({ url: `${base}/plain?a=1`, method: 'GET', expectedStatus: 200 }, 3_000)
    assert.deepEqual(seen.map((r) => r.url), ['/plain?a=1'])
  })

  it('shows the parameter in the test result', async () => {
    seen.length = 0
    const result = await testHttps({ url: `${base}/plain`, method: 'GET', expectedStatus: 200, cacheBuster: true }, 3_000)
    assert.equal(result.overall, 'ok')
    assert.match(result.steps.find((s) => s.label.startsWith('GET '))?.label ?? '', new RegExp(`\\?${CACHE_BUSTER_PARAM}=[0-9a-f]{16}$`))
    assert.match(seen[0]!.url, new RegExp(`^/plain\\?${CACHE_BUSTER_PARAM}=`))
  })

  it('is validated as a switch', () => {
    const body = (cacheBuster: unknown) => ({ name: 'Site', type: 'https', config: { url: 'https://example.test', method: 'GET', expectedStatus: 200, cacheBuster } })
    assert.ok('value' in parseNewMonitor(body(true)))
    const bad = parseNewMonitor(body('yes'))
    assert.ok('error' in bad && /cacheBuster must be true or false/.test(bad.error))
  })
})
