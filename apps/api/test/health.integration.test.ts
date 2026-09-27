import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { writeSetupComplete } from '../src/config.js'
import { healthRoutes } from '../src/routes/health.js'
import { createTestDb, initTestDb, teardownTestDb, type TestDb } from './helpers/testDb.js'

describe('health endpoints', () => {
  const previousSetupPath = process.env['SETUP_CONFIG_PATH']
  let testDb: TestDb
  const app = Fastify({ logger: false })

  before(async () => {
    testDb = createTestDb('bsp-health-test-', 'health.sqlite')
    process.env['SETUP_CONFIG_PATH'] = join(testDb.dir, 'setup.json')
    await app.register(healthRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    if (previousSetupPath === undefined) delete process.env['SETUP_CONFIG_PATH']
    else process.env['SETUP_CONFIG_PATH'] = previousSetupPath
    teardownTestDb(testDb)
  })

  it('reports liveness before setup and readiness after database initialization', async () => {
    const health = await app.inject('/health')
    assert.equal(health.statusCode, 200)
    assert.deepEqual(health.json(), { status: 'ok' })

    const beforeSetup = await app.inject('/ready')
    assert.equal(beforeSetup.statusCode, 503)
    assert.deepEqual(beforeSetup.json(), { status: 'not_ready' })

    initTestDb()
    writeSetupComplete()
    const afterSetup = await app.inject('/ready')
    assert.equal(afterSetup.statusCode, 200)
    assert.deepEqual(afterSetup.json(), { status: 'ready' })
  })
})
