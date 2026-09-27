import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it, mock } from 'node:test'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import cookie from '@fastify/cookie'
import { sqlite } from '../src/db/client.js'
import { setupRoutes } from '../src/routes/setup.js'
import { createTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-setup-test-')
process.env['SETUP_CONFIG_PATH'] = join(testDb.dir, 'setup.json')

const app = Fastify({ logger: false })
const schedulerStart = mock.fn()

before(async () => {
  await app.register(jwt, { secret: 'setup-integration-secret' })
  await app.register(cookie)
  await app.register(setupRoutes, { prefix: '/setup', startBackgroundServices: schedulerStart })
  await app.ready()
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

describe('first-run setup', () => {
  it('reports an incomplete installation and validates credentials', async () => {
    assert.deepEqual((await app.inject({ url: '/setup/status' })).json(), { needsSetup: true })
    assert.equal((await app.inject({ method: 'POST', url: '/setup/complete', payload: { email: '', password: '' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: '/setup/complete', payload: { email: 'admin@example.test', password: 'short' } })).statusCode, 400)
  })

  it('rolls back the admin when the setup marker cannot be written, so the same email can retry', async () => {
    // A directory at the marker path makes writeSetupComplete fail while isSetupComplete stays false.
    mkdirSync(process.env['SETUP_CONFIG_PATH']!)
    try {
      const failed = await app.inject({
        method: 'POST', url: '/setup/complete',
        payload: { email: 'owner@example.test', password: 'secure-password' },
      })
      assert.equal(failed.statusCode, 500)
      assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 0)
      assert.equal(schedulerStart.mock.callCount(), 0)
    } finally {
      rmSync(process.env['SETUP_CONFIG_PATH']!, { recursive: true, force: true })
    }
    // A row left behind by an interrupted attempt must not block setup either.
    sqlite.exec("INSERT INTO users(email,password_hash,role,created_at) VALUES ('owner@example.test','stale','viewer',1)")
  })

  it('initializes storage, seeds defaults, signs in, and starts scheduling once', async () => {
    const response = await app.inject({
      method: 'POST', url: '/setup/complete',
      payload: { email: 'owner@example.test', password: 'secure-password' },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().email, 'owner@example.test')
    assert.match(String(response.headers['set-cookie']), /bsp_session=/)
    assert.equal(existsSync(process.env['DATABASE_PATH']!), true)
    assert.equal(existsSync(process.env['SETUP_CONFIG_PATH']!), true)
    assert.equal(schedulerStart.mock.callCount(), 1)
    const admin = sqlite.prepare("SELECT role, password_hash AS hash FROM users WHERE email = 'owner@example.test'").get() as { role: string; hash: string }
    assert.equal(admin.role, 'admin')
    assert.notEqual(admin.hash, 'stale')
    assert.deepEqual((await app.inject({ url: '/setup/status' })).json(), { needsSetup: false })
    assert.equal((await app.inject({ method: 'POST', url: '/setup/complete', payload: { email: 'other@example.test', password: 'secure-password' } })).statusCode, 409)
    assert.equal(schedulerStart.mock.callCount(), 1)
  })
})
