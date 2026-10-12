import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'
import type { HttpAssertion, HttpsConfig } from '@bsp/shared'
import { parseJsonPath, validateHttpAssertions } from '../src/workers/assertions.js'
import { checkHttps } from '../src/workers/https.js'
import { testHttps } from '../src/workers/testRunner.js'

const payload = { queue: { length: 150 }, items: [{ id: 'a' }, { id: 'b' }], ok: true, nothing: null, name: 'api', tags: ['x', 'y'] }

const server = createServer((req, res) => {
  if (req.url === '/api') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Replicas': '2', 'Set-Cookie': 'session=secret-value' })
    res.end(JSON.stringify(payload))
  } else if (req.url === '/text') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('plain text')
  } else if (req.url === '/huge') {
    res.writeHead(200, { 'Content-Length': String(2 * 1024 * 1024) })
    res.end('x'.repeat(2 * 1024 * 1024))
  } else if (req.url === '/slow') {
    setTimeout(() => res.writeHead(200).end('ok'), 120)
  } else {
    res.writeHead(404).end()
  }
})

let baseUrl = ''
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})
after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const config = (path: string, extra: Partial<HttpsConfig> = {}): HttpsConfig =>
  ({ url: `${baseUrl}${path}`, method: 'GET', expectedStatus: 200, ...extra })

const check = (assertions: HttpAssertion[], path = '/api', extra: Partial<HttpsConfig> = {}) =>
  checkHttps(config(path, { assertions, ...extra }), 3_000)

describe('header assertions', () => {
  it('passes when a header exists or equals the value, whatever the name casing', async () => {
    const result = await check([
      { type: 'header', name: 'x-replicas', op: 'exists' },
      { type: 'header', name: 'X-REPLICAS', op: 'equals', value: '2' },
      { type: 'header', name: 'X-Replicas', op: 'not-equals', value: '3' },
      { type: 'header', name: 'Content-Type', op: 'contains', value: 'json' },
      { type: 'header', name: 'X-Missing', op: 'not-exists' },
    ])
    assert.equal(result.status, 'up', result.error ?? '')
  })

  it('fails a missing header and a different value, Degraded unless told otherwise', async () => {
    const missing = await check([{ type: 'header', name: 'X-Missing', op: 'exists' }])
    assert.equal(missing.status, 'degraded')
    assert.match(missing.error ?? '', /Header "X-Missing" exists failed: the header is missing/)

    const different = await check([{ type: 'header', name: 'X-Replicas', op: 'equals', value: '3', onFail: 'down' }])
    assert.equal(different.status, 'down')
    assert.match(different.error ?? '', /it is "2"/)
  })

  it('never shows what a credential header held', async () => {
    const result = await check([{ type: 'header', name: 'Set-Cookie', op: 'equals', value: 'other' }])
    assert.equal(result.status, 'degraded')
    assert.doesNotMatch(result.error ?? '', /secret-value/)
  })
})

describe('JSON assertions', () => {
  it('reads fields, array items and quoted keys', async () => {
    const result = await check([
      { type: 'json', path: '$.queue.length', op: 'lt', value: 200 },
      { type: 'json', path: '$.queue.length', op: 'gt', value: '100' },
      { type: 'json', path: '$.items[1].id', op: 'equals', value: 'b' },
      { type: 'json', path: "$['name']", op: 'equals', value: 'api' },
      { type: 'json', path: '$.ok', op: 'equals', value: 'true' },
      { type: 'json', path: '$.nothing', op: 'exists' },
      { type: 'json', path: '$.tags', op: 'contains', value: 'y' },
      { type: 'json', path: '$.name', op: 'contains', value: 'p' },
      { type: 'json', path: '$.absent', op: 'not-exists' },
      { type: 'json', path: '$.absent', op: 'not-equals', value: 'x' },
    ])
    assert.equal(result.status, 'up', result.error ?? '')
  })

  it('reports the actual value of a failed comparison', async () => {
    const result = await check([{ type: 'json', path: '$.queue.length', op: 'lt', value: 100 }])
    assert.equal(result.status, 'degraded')
    assert.match(result.error ?? '', /\$\.queue\.length is less than 100 failed: it is 150/)
  })

  it('fails a missing field, a non-number for lt/gt and a path through a scalar', async () => {
    for (const assertion of [
      { type: 'json', path: '$.absent', op: 'exists' },
      { type: 'json', path: '$.name', op: 'lt', value: 5 },
      { type: 'json', path: '$.name.deeper', op: 'exists' },
      { type: 'json', path: '$.items[9]', op: 'exists' },
    ] as HttpAssertion[]) {
      assert.equal((await check([assertion])).status, 'degraded', JSON.stringify(assertion))
    }
  })

  it('fails the JSON assertions, not the check, when the body is not JSON or too large', async () => {
    const text = await check([{ type: 'json', path: '$.a', op: 'exists', onFail: 'down' }], '/text')
    assert.equal(text.status, 'down')
    assert.match(text.error ?? '', /not valid JSON/)

    const huge = await check([{ type: 'json', path: '$.a', op: 'exists' }], '/huge')
    assert.equal(huge.status, 'degraded')
    assert.match(huge.error ?? '', /larger than 1 MB/)
  })
})

describe('combined results', () => {
  it('reports every failure and lets a Down assertion win over a Degraded one', async () => {
    const result = await check(
      [
        { type: 'header', name: 'X-Missing', op: 'exists' },
        { type: 'json', path: '$.ok', op: 'equals', value: 'false', onFail: 'down' },
      ],
      '/api',
      { keyword: 'not in the body' },
    )
    assert.equal(result.status, 'down')
    assert.match(result.error ?? '', /Keyword .* not found.*X-Missing.*\$\.ok/)
  })

  it('does not evaluate assertions when the status code is already wrong', async () => {
    const result = await check([{ type: 'header', name: 'X-Replicas', op: 'exists' }], '/nothing')
    assert.equal(result.status, 'down')
    assert.match(result.error ?? '', /Expected HTTP 200, got 404/)
  })

  it('turns a slow response Degraded', async () => {
    const slow = await checkHttps(config('/slow', { degradedAboveMs: 50 }), 3_000)
    assert.equal(slow.status, 'degraded')
    assert.match(slow.error ?? '', /over the 50 ms limit/)

    const fast = await checkHttps(config('/api', { degradedAboveMs: 5_000 }), 3_000)
    assert.equal(fast.status, 'up')
  })
})

describe('test run', () => {
  it('lists each assertion as a step and fails with the severity the check would have', async () => {
    const result = await testHttps(config('/api', {
      assertions: [
        { type: 'header', name: 'X-Replicas', op: 'equals', value: '2' },
        { type: 'json', path: '$.queue.length', op: 'lt', value: 100, onFail: 'down' },
      ],
    }), 3_000)
    assert.equal(result.overall, 'error')
    const steps = result.steps.map((s) => `${s.status}: ${s.label}${s.detail ? ` | ${s.detail}` : ''}`)
    assert.ok(steps.includes('ok: Header "X-Replicas" equals "2"'), steps.join('\n'))
    assert.ok(steps.some((s) => s.startsWith('error: $.queue.length is less than 100') && s.includes('would be Down')), steps.join('\n'))
  })

  it('passes when all assertions hold and rejects an invalid assertion without a request', async () => {
    const ok = await testHttps(config('/api', { assertions: [{ type: 'header', name: 'X-Replicas', op: 'exists' }] }), 3_000)
    assert.equal(ok.overall, 'ok')

    const bad = await testHttps(config('/api', { assertions: [{ type: 'json', path: 'nope', op: 'exists' }] }), 3_000)
    assert.equal(bad.overall, 'error')
    assert.equal(bad.steps[0]?.label, 'Invalid configuration')
  })
})

describe('parseJsonPath', () => {
  it('reads dotted names, indexes and quoted keys', () => {
    assert.deepEqual(parseJsonPath('$'), [])
    assert.deepEqual(parseJsonPath('$.a.b[0].c'), ['a', 'b', 0, 'c'])
    assert.deepEqual(parseJsonPath("$['a b'][\"c\"]"), ['a b', 'c'])
  })

  it('rejects anything outside that subset', () => {
    for (const path of ['a.b', '$.', '$..a', '$[*]', '$.a[', '$[-1]', '$.a b', `$.${'a'.repeat(300)}`]) {
      assert.equal(parseJsonPath(path), null, path)
    }
  })
})

describe('validateHttpAssertions', () => {
  it('accepts a missing or valid configuration', () => {
    assert.equal(validateHttpAssertions({}), null)
    assert.equal(validateHttpAssertions({ degradedAboveMs: 1_500, assertions: [{ type: 'header', name: 'X-A', op: 'exists' }] }), null)
  })

  it('names the first problem', () => {
    const problems: [Partial<HttpsConfig> | Record<string, unknown>, RegExp][] = [
      [{ degradedAboveMs: 0 }, /degradedAboveMs/],
      [{ degradedAboveMs: 1.5 }, /degradedAboveMs/],
      [{ assertions: 'x' }, /must be a list/],
      [{ assertions: Array.from({ length: 21 }, () => ({ type: 'header', name: 'A', op: 'exists' })) }, /At most 20/],
      [{ assertions: [null] }, /Assertion 1 must be an object/],
      [{ assertions: [{ type: 'cookie' }] }, /type must be/],
      [{ assertions: [{ type: 'header', name: 'A', op: 'lt', value: '1' }] }, /op must be one of/],
      [{ assertions: [{ type: 'header', name: 'bad name', op: 'exists' }] }, /valid header name/],
      [{ assertions: [{ type: 'header', name: 'A', op: 'equals' }] }, /value is required/],
      [{ assertions: [{ type: 'header', name: 'A', op: 'equals', value: 2 }] }, /value is required/],
      [{ assertions: [{ type: 'json', path: 'x', op: 'exists' }] }, /path must look like/],
      [{ assertions: [{ type: 'json', path: '$.a', op: 'lt', value: 'abc' }] }, /must be a number/],
      [{ assertions: [{ type: 'json', path: '$.a', op: 'equals', value: 'x'.repeat(1001) }] }, /at most 1000/],
      [{ assertions: [{ type: 'json', path: '$.a', op: 'exists', onFail: 'up' }] }, /onFail/],
    ]
    for (const [input, expected] of problems) {
      assert.match(validateHttpAssertions(input as Partial<HttpsConfig>) ?? '', expected, JSON.stringify(input).slice(0, 80))
    }
  })
})
