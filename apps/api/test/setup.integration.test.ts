import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it, mock } from 'node:test'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { sqlite } from '../src/db/client.js'
import { setupRoutes } from '../src/routes/setup.js'

const dataDir = mkdtempSync(join(tmpdir(), 'bsp-setup-test-'))
process.env['DATABASE_PATH'] = join(dataDir, 'test.sqlite')
process.env['SETUP_CONFIG_PATH'] = join(dataDir, 'setup.json')

const app = Fastify({ logger: false })
const schedulerStart = mock.fn()

before(async () => {
  await app.register(jwt, { secret: 'setup-integration-secret' })
  await app.register(setupRoutes, { prefix: '/setup', startScheduler: schedulerStart })
  await app.ready()
})

after(async () => {
  await app.close()
  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('first-run setup', () => {
  it('reports an incomplete installation and validates credentials', async () => {
    assert.deepEqual((await app.inject({ url: '/setup/status' })).json(), { needsSetup: true })
    assert.equal((await app.inject({ method: 'POST', url: '/setup/complete', payload: { email: '', password: '' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: '/setup/complete', payload: { email: 'admin@example.test', password: 'short' } })).statusCode, 400)
  })

  it('initializes storage, seeds defaults, signs in, and starts scheduling once', async () => {
    const response = await app.inject({
      method: 'POST', url: '/setup/complete',
      payload: { email: 'owner@example.test', password: 'secure-password' },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(typeof response.json().token, 'string')
    assert.equal(existsSync(process.env['DATABASE_PATH']!), true)
    assert.equal(existsSync(process.env['SETUP_CONFIG_PATH']!), true)
    assert.equal(schedulerStart.mock.callCount(), 1)
    assert.deepEqual((await app.inject({ url: '/setup/status' })).json(), { needsSetup: false })
    assert.equal((await app.inject({ method: 'POST', url: '/setup/complete', payload: { email: 'other@example.test', password: 'secure-password' } })).statusCode, 409)
    assert.equal(schedulerStart.mock.callCount(), 1)
  })
})
