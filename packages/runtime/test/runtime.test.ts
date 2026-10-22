import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import Fastify from 'fastify'
import { openDatabase } from '@better-kit/db'
import {
  createAppLock, createHealthRoutes, createPublicUrlResolver, createSystemHealth, createUpdateCheck, dataDir, databasePath,
  isNewerVersion, isSetupComplete, resolveAppVersion, resolveTrustProxy, writeSetupComplete,
} from '@better-kit/runtime'

const dir = mkdtempSync(join(tmpdir(), 'kit-runtime-'))
after(() => rmSync(dir, { recursive: true, force: true }))

describe('data paths', () => {
  it('derive from DATA_DIR unless a path is set explicitly', () => {
    assert.equal(dataDir({ DATA_DIR: dir }), dir)
    assert.equal(databasePath({ DATA_DIR: dir }), join(dir, 'db.sqlite'))
    assert.equal(databasePath({ DATA_DIR: dir, DATABASE_PATH: join(dir, 'x.sqlite') }), join(dir, 'x.sqlite'))
  })

  it('remember that setup was completed', () => {
    const env = { DATA_DIR: join(dir, 'setup') }
    assert.equal(isSetupComplete(env), false)
    writeSetupComplete('sqlite', env)
    assert.equal(isSetupComplete(env), true)
  })

  it('treat a marker that cannot be parsed as completed setup', () => {
    const env = { DATA_DIR: join(dir, 'broken') }
    mkdirSync(env.DATA_DIR)
    writeFileSync(join(env.DATA_DIR, 'setup.json'), '{"setupComp')
    assert.equal(isSetupComplete(env), true)
  })
})

describe('proxy trust and the public address', () => {
  it('understand the TRUST_PROXY forms', () => {
    assert.equal(resolveTrustProxy(undefined), false)
    assert.equal(resolveTrustProxy('true'), true)
    assert.deepEqual(resolveTrustProxy('2'), ['loopback', 'uniquelocal'])
    assert.deepEqual(resolveTrustProxy('10.0.0.1, 10.0.0.2'), ['10.0.0.1', '10.0.0.2'])
  })

  it('accept only an absolute http(s) PUBLIC_URL and warn once about a bad one', () => {
    const resolve = createPublicUrlResolver()
    const warn = console.warn
    const warnings: string[] = []
    console.warn = (message: string) => { warnings.push(message) }
    try {
      assert.equal(resolve({ PUBLIC_URL: 'https://example.test/' }), 'https://example.test')
      assert.equal(resolve({ PUBLIC_URL: 'example.test' }), '')
      assert.equal(resolve({ PUBLIC_URL: 'example.test' }), '')
      assert.equal(resolve({}), '')
    } finally {
      console.warn = warn
    }
    assert.equal(warnings.length, 1)
  })

  it('prefers the environment version of the application', () => {
    assert.equal(resolveAppVersion('1.2.3', {}), '1.2.3')
    assert.equal(resolveAppVersion('1.2.3', { APP_VERSION: ' 2.0.0 ' }), '2.0.0')
  })
})

describe('app lock', () => {
  it('refuses a second holder, names the application, and frees the marker on release', () => {
    const lockDir = join(dir, 'lock')
    const lock = createAppLock({ name: 'Example', fileName: '.example-running', dir: () => lockDir })
    const release = lock.acquireAppLock()
    try {
      assert.ok(existsSync(join(lockDir, '.example-running')))
      assert.throws(() => lock.assertAppStopped(), /Example is still running/)
    } finally {
      release()
    }
    assert.equal(existsSync(join(lockDir, '.example-running')), false)
    assert.doesNotThrow(() => lock.assertAppStopped())
  })
})

describe('update check', () => {
  it('compares plain release versions only', () => {
    assert.equal(isNewerVersion('1.2.0', '1.1.9'), true)
    assert.equal(isNewerVersion('1.1.0', '1.1.0'), false)
    assert.equal(isNewerVersion('1.2.0-beta', '1.1.0'), false)
  })

  it('asks the repository it was given and points out a newer release', async () => {
    const check = createUpdateCheck({ name: 'Example', repository: 'acme/example', version: () => '1.0.0' })
    const realFetch = globalThis.fetch
    const asked: Array<{ url: string; agent: string }> = []
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      asked.push({ url: String(url), agent: (init?.headers as Record<string, string>)['User-Agent'] ?? '' })
      return new Response(JSON.stringify({ tag_name: 'v1.1.0', html_url: 'https://github.com/acme/example/releases/tag/v1.1.0', draft: false, prerelease: false }), { status: 200 })
    }) as typeof fetch
    try {
      assert.equal(await check.checkForUpdate(), true)
    } finally {
      globalThis.fetch = realFetch
    }
    assert.deepEqual(asked, [{ url: 'https://api.github.com/repos/acme/example/releases/latest', agent: 'Example/1.0.0' }])
    assert.deepEqual(check.getAvailableUpdate(), { version: '1.1.0', url: 'https://github.com/acme/example/releases/tag/v1.1.0' })
  })
})

describe('health', () => {
  const database = openDatabase({ path: join(dir, 'health.sqlite'), schema: {} })
  after(() => database.close())

  it('reports ready only once setup is complete and the database answers', async () => {
    let complete = false
    const app = Fastify({ logger: false })
    await app.register(createHealthRoutes({ db: database.db, isSetupComplete: () => complete }))
    try {
      assert.equal((await app.inject('/health')).statusCode, 200)
      assert.equal((await app.inject('/ready')).statusCode, 503)
      complete = true
      assert.deepEqual((await app.inject('/ready')).json(), { status: 'ready' })
    } finally {
      await app.close()
    }
  })

  it('builds the system report from the sections of its contributors and degrades on a failing critical one', async () => {
    let queueStatus: 'ok' | 'error' = 'ok'
    const health = createSystemHealth({
      db: database.db,
      version: () => '1.0.0',
      update: () => null,
      contributors: [
        { key: 'queue', critical: false, collect: () => ({ status: queueStatus, depth: 3 }) },
        { key: 'jobs', critical: true, collect: ({ databaseOk }) => ({ status: databaseOk ? 'ok' : 'error' }) },
      ],
    })
    const report = await health.getSystemHealthReport(1000)
    assert.deepEqual(Object.keys(report), ['status', 'generatedAt', 'application', 'database', 'queue', 'jobs'])
    assert.equal(report.status, 'healthy')
    assert.equal((report['application'] as { version: string }).version, '1.0.0')

    queueStatus = 'error'
    assert.equal((await health.getSystemHealthReport(1000)).status, 'healthy')

    const failing = createSystemHealth({
      db: database.db, version: () => '1', update: () => null,
      contributors: [{ key: 'jobs', critical: true, collect: () => ({ status: 'error' }) }],
    })
    assert.equal((await failing.getSystemHealthReport()).status, 'degraded')
  })
})
