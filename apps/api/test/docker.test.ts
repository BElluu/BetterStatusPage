import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { checkDocker, evaluateContainer, parseDockerEndpoint, validateDockerConfig } from '../src/workers/docker.js'
import { testDocker } from '../src/workers/testRunner.js'

const containers: Record<string, unknown> = {
  healthy: { State: { Status: 'running', Running: true, Health: { Status: 'healthy' } } },
  plain: { State: { Status: 'running', Running: true } },
  unhealthy: { State: { Status: 'running', Running: true, Health: { Status: 'unhealthy' } } },
  starting: { State: { Status: 'running', Running: true, Health: { Status: 'starting' } } },
  restarting: { State: { Status: 'restarting', Running: true, Restarting: true } },
  paused: { State: { Status: 'paused', Running: true, Paused: true } },
  stopped: { State: { Status: 'exited', Running: false } },
  'my-app.1': { State: { Status: 'running', Running: true } },
}

let server: http.Server
let endpoint: string

before(async () => {
  server = http.createServer((req, res) => {
    const match = /^\/containers\/([^/]+)\/json$/.exec(req.url ?? '')
    const name = match ? decodeURIComponent(match[1] ?? '') : null
    if (name === 'boom') { res.writeHead(500).end('{}'); return }
    if (name === 'hang') return
    if (name === 'huge') { res.writeHead(200).end('x'.repeat(2 * 1024 * 1024)); return }
    if (name === 'html') { res.writeHead(200).end('<html><body>nope</body></html>'); return }
    const body = name ? containers[name] : undefined
    if (!body) { res.writeHead(404).end('{"message":"No such container"}'); return }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})

after(() => { server.closeAllConnections(); server.close() })

describe('Docker monitor', () => {
  const check = (container: string, timeout = 2000) => checkDocker({ endpoint, container }, timeout)

  it('is up for a running container with or without a healthcheck', async () => {
    assert.equal((await check('healthy')).status, 'up')
    const plain = await check('plain')
    assert.equal(plain.status, 'up')
    assert.equal(plain.error, null)
    assert.ok(plain.responseMs !== null)
  })

  it('is degraded when unhealthy, still starting or restarting', async () => {
    assert.equal((await check('unhealthy')).status, 'degraded')
    assert.equal((await check('starting')).status, 'degraded')
    assert.equal((await check('restarting')).status, 'degraded')
  })

  it('is down when stopped, paused or missing', async () => {
    assert.match((await check('stopped')).error ?? '', /not running \(exited\)/)
    assert.equal((await check('paused')).status, 'down')
    const missing = await check('nope')
    assert.equal(missing.status, 'down')
    assert.match(missing.error ?? '', /not found/)
  })

  it('passes names with dots and dashes', async () => {
    assert.equal((await check('my-app.1')).status, 'up')
  })

  it('is down on API errors, timeouts and bad configuration', async () => {
    assert.match((await check('boom')).error ?? '', /HTTP 500/)
    assert.equal((await check('hang', 150)).status, 'down')
    assert.match((await checkDocker({ endpoint, container: '  ' }, 500)).error ?? '', /required/)
    assert.match((await checkDocker({ endpoint: 'ftp://x', container: 'a' }, 500)).error ?? '', /Endpoint must start with/)
    assert.equal((await checkDocker({ endpoint: 'http://127.0.0.1:1', container: 'a' }, 500)).status, 'down')
  })

  it('rejects path injection and unsafe endpoints', async () => {
    for (const container of ['.', '..', '../x', 'a/b', 'a?b', '-x']) {
      assert.ok(validateDockerConfig({ endpoint, container }), container)
    }
    assert.equal(validateDockerConfig({ endpoint, container: 'my-app_1.web' }), null)
    for (const bad of ['http://h:2375/images/get?names=x', 'http://h:2375/v1', 'http://u:p@h:2375', 'npipe:////attacker/pipe/x', 'npipe:////./pipe/a/b', 'unix://relative.sock', 'ftp://x', '']) {
      assert.ok(validateDockerConfig({ endpoint: bad, container: 'a' }), bad)
    }
    assert.ok(validateDockerConfig(null))
    assert.match((await checkDocker({ endpoint, container: '..' }, 500)).error ?? '', /may only contain/)
  })

  it('parses endpoints', () => {
    assert.equal(parseDockerEndpoint('https://docker.test:2376/').origin, 'https://docker.test:2376')
    assert.equal(parseDockerEndpoint('npipe:////./pipe/docker_engine').socketPath, String.raw`\\.\pipe\docker_engine`)
    if (process.platform !== 'win32') assert.equal(parseDockerEndpoint('unix:///var/run/docker.sock').socketPath, '/var/run/docker.sock')
    else assert.throws(() => parseDockerEndpoint('unix:///var/run/docker.sock'), /not supported on Windows/)
  })

  it('rejects oversized and non-JSON responses', async () => {
    assert.match((await check('huge')).error ?? '', /too large/)
    assert.match((await check('html')).error ?? '', /non-JSON/)
  })

  it('talks to a local socket or pipe', async () => {
    const win = process.platform === 'win32'
    const path = win ? String.raw`\\.\pipe\bsp-test-${process.pid}` : join(tmpdir(), `bsp-docker-${process.pid}.sock`)
    const local = http.createServer((_req, res) => { res.writeHead(200).end(JSON.stringify(containers['healthy'])) })
    await new Promise<void>((resolve) => local.listen(path, resolve))
    try {
      const endpoint = win ? `npipe:////./pipe/bsp-test-${process.pid}` : `unix://${path}`
      assert.equal((await checkDocker({ endpoint, container: 'healthy' }, 2000)).status, 'up')
    } finally {
      local.closeAllConnections(); local.close()
    }
  })

  it('evaluates states', () => {
    const base = { running: false, paused: false, restarting: false, status: 'created', health: null }
    assert.equal(evaluateContainer(null, 'x').status, 'down')
    assert.equal(evaluateContainer(base, 'x').status, 'down')
    assert.equal(evaluateContainer({ ...base, running: true, paused: true, restarting: true }, 'x').error, 'Container is paused')
  })

  it('test runner reports steps', async () => {
    const ok = await testDocker({ endpoint, container: 'healthy' }, 2000)
    assert.equal(ok.overall, 'ok')
    assert.ok(ok.steps.some((s) => s.detail?.includes('health: healthy')))
    const bad = await testDocker({ endpoint, container: 'unhealthy' }, 2000)
    assert.equal(bad.overall, 'error')
    assert.equal((await testDocker({ endpoint, container: 'nope' }, 2000)).overall, 'error')
    assert.equal((await testDocker({ endpoint: 'bad', container: 'a' }, 2000)).steps.at(-1)?.label, 'Invalid configuration')
    assert.equal((await testDocker({ endpoint, container: 'boom' }, 2000)).steps.at(-1)?.label, 'Docker API request failed')
  })
})
