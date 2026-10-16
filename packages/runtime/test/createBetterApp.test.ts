import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { createBetterApp, resolveJwtSecret, type BetterAppOptions } from '@better-kit/runtime'

let dir: string
let calls: string[]
const env = { ...process.env }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-app-'))
  calls = []
})

afterEach(() => {
  process.env = { ...env }
  mock.restoreAll()
  fs.rmSync(dir, { recursive: true, force: true })
})

function options(overrides: Partial<BetterAppOptions> & { ready?: boolean } = {}): BetterAppOptions {
  const { ready = true, ...rest } = overrides
  return {
    uploads: { dir: path.join(dir, 'uploads'), maxFileBytes: 1024 },
    database: {
      isReady: () => ready, open: () => calls.push('open'), migrate: () => calls.push('migrate'), close: () => calls.push('close'),
    },
    routes: async (app) => {
      app.get('/ping', async () => ({ ok: true }))
      app.post('/change', async () => ({ changed: true }))
    },
    acquireLock: () => { calls.push('lock'); return () => calls.push('unlock') },
    logName: 'Test app',
    port: 0,
    ...rest,
  }
}

/** The process keeps the shutdown signal handlers a running app installs; a test removes the ones it added. */
function signalListeners() {
  const before = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') }
  return () => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      for (const listener of process.listeners(signal)) if (!before[signal].includes(listener)) process.removeListener(signal, listener)
    }
  }
}

describe('resolveJwtSecret', () => {
  it('uses the configured secret, or an insecure default with a warning outside production', () => {
    const warn = mock.method(console, 'warn', () => undefined)
    assert.equal(resolveJwtSecret({ JWT_SECRET: 'abc' }), 'abc')
    assert.equal(warn.mock.callCount(), 0)
    assert.equal(resolveJwtSecret({}), 'dev-secret-change-me')
    assert.equal(warn.mock.callCount(), 1)
  })

  it('insists on a real secret in production', () => {
    const production = { NODE_ENV: 'production' }
    for (const secret of [undefined, 'short', 'change-me-to-a-long-random-string', 'change-me-to-a-64-char-hex-string']) {
      assert.throws(() => resolveJwtSecret({ ...production, ...(secret ? { JWT_SECRET: secret } : {}) }), /JWT_SECRET must be set/)
    }
    assert.equal(resolveJwtSecret({ ...production, JWT_SECRET: 'x'.repeat(32) }), 'x'.repeat(32))
  })
})

describe('createBetterApp', () => {
  it('serves the routes with the security headers, and makes the uploads directory', async () => {
    mock.method(console, 'warn', () => undefined)
    const { app } = await createBetterApp(options())
    const response = await app.inject('/ping')
    assert.deepEqual(response.json(), { ok: true })
    assert.equal(response.headers['x-content-type-options'], 'nosniff')
    assert.equal(response.headers['x-frame-options'], 'DENY')
    assert.match(String(response.headers['content-security-policy']), /frame-ancestors 'none'/)
    assert.equal(response.headers['strict-transport-security'], undefined)
    assert.ok(fs.existsSync(path.join(dir, 'uploads')))
    await app.close()
  })

  it('lets the application allow its own origin to frame a page, and nothing else', async () => {
    mock.method(console, 'warn', () => undefined)
    const { app } = await createBetterApp(options({ allowSameOriginFraming: ({ path: p, query }) => p === '/ping' && query.get('preview') === '1' }))
    const framed = await app.inject('/ping?preview=1')
    assert.equal(framed.headers['x-frame-options'], 'SAMEORIGIN')
    assert.match(String(framed.headers['content-security-policy']), /frame-ancestors 'self'/)
    assert.equal((await app.inject('/ping?preview=0')).headers['x-frame-options'], 'DENY')
    await app.close()
  })

  it('opens and migrates the database only once the application is set up, and checks what the application asks first', async () => {
    mock.method(console, 'warn', () => undefined)
    const { app } = await createBetterApp(options({ validate: () => calls.push('validate') }))
    assert.deepEqual(calls, ['validate', 'open', 'migrate'])
    await app.close()
    calls.length = 0
    const waiting = await createBetterApp(options({ ready: false }))
    assert.deepEqual(calls, [])
    await waiting.app.close()
    await assert.rejects(() => createBetterApp(options({ validate: () => { throw new Error('no key') } })), /no key/)
  })

  it('serves the front-ends in production only, after the routes', async () => {
    process.env['NODE_ENV'] = 'development'
    process.env['JWT_SECRET'] = 'x'.repeat(40)
    const frontends = async () => { calls.push('frontends') }
    await (await createBetterApp(options({ frontends }))).app.close()
    assert.ok(!calls.includes('frontends'))
    process.env['NODE_ENV'] = 'production'
    await (await createBetterApp(options({ frontends }))).app.close()
    assert.ok(calls.includes('frontends'))
  })

  it('in production refuses cross-site changes and other origins, and sends the transport security header', async () => {
    process.env['NODE_ENV'] = 'production'
    process.env['JWT_SECRET'] = 'x'.repeat(40)
    const { app } = await createBetterApp(options())
    const post = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/change', headers: { host: 'app.test', ...headers } })
    assert.equal((await post({ 'sec-fetch-site': 'cross-site' })).statusCode, 403)
    assert.equal((await post({ origin: 'https://evil.test' })).statusCode, 403)
    assert.equal((await post({ origin: 'http://app.test' })).statusCode, 200)
    assert.equal((await post({})).statusCode, 200)
    const ping = await app.inject('/ping')
    assert.equal(ping.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains')
    await app.close()
  })

  it('takes the lock when it runs, listens, and gives everything back when it closes', async () => {
    mock.method(console, 'warn', () => undefined)
    const log = mock.method(console, 'log', () => undefined)
    const restore = signalListeners()
    const { app, run } = await createBetterApp(options({
      stopIntake: () => calls.push('stopIntake'),
      backgroundServices: { start: () => calls.push('start'), stop: () => calls.push('stop') },
    }))
    calls.length = 0
    await run()
    assert.deepEqual(calls, ['lock', 'start'])
    assert.match(String(log.mock.calls[0]!.arguments[0]), /Test app running on http:\/\/localhost:/)
    await app.close()
    assert.deepEqual(calls.slice(2).sort(), ['close', 'stop', 'stopIntake', 'unlock'])
    restore()
  })

  it('does not start the background services before the application is set up', async () => {
    mock.method(console, 'warn', () => undefined)
    mock.method(console, 'log', () => undefined)
    const restore = signalListeners()
    const { app, run } = await createBetterApp(options({ ready: false, backgroundServices: { start: () => calls.push('start'), stop: () => undefined } }))
    await run()
    assert.ok(!calls.includes('start'))
    await app.close()
    restore()
  })
})
