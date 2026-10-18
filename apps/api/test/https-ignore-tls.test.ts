import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { HttpFetch } from '../src/workers/httpAuth.js'
import { insecureForOrigin, skipsTlsVerification } from '../src/workers/httpAuth.js'
import { certResetsFor, parseMonitorPatch, parseNewMonitor } from '../src/services/monitorInput.js'
import { checkHttps } from '../src/workers/https.js'
import { testHttps } from '../src/workers/testRunner.js'

// A self-signed certificate valid for 100 years, checked in so the tests need no openssl.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url))

describe('HTTPS monitor with a self-signed certificate', () => {
  let server: Server
  let url = ''
  let served = 0

  before(async () => {
    server = createServer({ key: fixture('self-signed-key.pem'), cert: fixture('self-signed-cert.pem') }, (_req, res) => {
      served++
      res.writeHead(200).end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind')
    url = `https://127.0.0.1:${address.port}/`
  })

  beforeEach(() => { served = 0 })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('is Down by default, before any request reaches the server', async () => {
    const result = await checkHttps({ url, method: 'GET', expectedStatus: 200 }, 5000)
    assert.equal(result.status, 'down')
    assert.equal(served, 0)
  })

  it('is Up with ignoreTls', async () => {
    const result = await checkHttps({ url, method: 'GET', expectedStatus: 200, keyword: 'ok', ignoreTls: true }, 5000)
    assert.equal(result.status, 'up')
    assert.equal(result.error, null)
    assert.equal(served, 1)
  })

  it('test runner reaches the endpoint with ignoreTls only', async () => {
    const strict = await testHttps({ url, method: 'GET', expectedStatus: 200 }, 5000)
    assert.equal(strict.overall, 'error')
    assert.equal(served, 0)

    const lenient = await testHttps({ url, method: 'GET', expectedStatus: 200, ignoreTls: true }, 5000)
    assert.equal(lenient.overall, 'ok')
    assert.equal(served, 1)
    assert.ok(lenient.steps.some((s) => s.label === 'TLS certificate is not verified'))
  })
})

describe('ignoreTls scope', () => {
  const calls: string[] = []
  const verified: HttpFetch = async (u) => { calls.push(`verified ${u}`); return {} as never }
  const insecure: HttpFetch = async (u) => { calls.push(`insecure ${u}`); return {} as never }
  const init = { redirect: 'manual' as const, signal: new AbortController().signal }

  it('skips verification only for the monitored origin, not for a separate auth server', async () => {
    calls.length = 0
    const scoped = insecureForOrigin('https://device.lan:8443/status', verified, insecure)
    await scoped('https://device.lan:8443/api', init)
    await scoped('https://login.example.com/token', init)
    await scoped('https://device.lan:9443/other', init)
    assert.deepEqual(calls, [
      'insecure https://device.lan:8443/api',
      'verified https://login.example.com/token',
      'verified https://device.lan:9443/other',
    ])
  })

  it('applies to https URLs only', () => {
    assert.equal(skipsTlsVerification({ url: 'https://a.test', ignoreTls: true }), true)
    assert.equal(skipsTlsVerification({ url: 'http://a.test', ignoreTls: true }), false)
    assert.equal(skipsTlsVerification({ url: 'https://a.test' }), false)
    assert.equal(skipsTlsVerification({ url: 'https://a.test', ignoreTls: 'true' as never }), false)
  })
})

describe('ignoreTls input', () => {
  const body = (ignoreTls: unknown) => ({ name: 'M', type: 'https', config: { url: 'https://a.test', ignoreTls } })

  it('accepts a boolean and rejects anything else on create and update', () => {
    assert.ok('value' in parseNewMonitor(body(true)))
    assert.ok('value' in parseNewMonitor(body(false)))
    assert.ok('error' in parseNewMonitor(body('yes')))
    assert.ok('error' in parseNewMonitor(body(1)))

    const existing = { type: 'https', failureThreshold: 1, recoveryThreshold: 1 }
    assert.ok('value' in parseMonitorPatch({ config: { url: 'https://a.test', ignoreTls: true } }, existing))
    assert.ok('error' in parseMonitorPatch({ config: { url: 'https://a.test', ignoreTls: 'yes' } }, existing))
  })

  it('forgets the known certificate when the option is turned on or off, and keeps it otherwise', () => {
    const off = { url: 'https://a.test' }
    const on = { url: 'https://a.test', ignoreTls: true }
    assert.deepEqual(certResetsFor(off, on), { certCheckedAt: null, certExpiresAt: null, certWarnedDays: null })
    assert.deepEqual(certResetsFor(on, off), { certCheckedAt: null, certExpiresAt: null, certWarnedDays: null })
    assert.deepEqual(certResetsFor(off, { ...off, certExpiry: { enabled: true, warnDays: 7 } }), { certCheckedAt: null })
  })
})
