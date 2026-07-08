import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { writeSetupComplete } from '../src/config.js'
import { closeDb, initDb } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { healthRoutes } from '../src/routes/health.js'

describe('health endpoints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsp-health-test-'))
  const previousSetupPath = process.env['SETUP_CONFIG_PATH']
  const previousDatabasePath = process.env['DATABASE_PATH']
  const app = Fastify({ logger: false })

  before(async () => {
    process.env['SETUP_CONFIG_PATH'] = join(dir, 'setup.json')
    process.env['DATABASE_PATH'] = join(dir, 'health.sqlite')
    await app.register(healthRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    closeDb()
    if (previousSetupPath === undefined) delete process.env['SETUP_CONFIG_PATH']
    else process.env['SETUP_CONFIG_PATH'] = previousSetupPath
    if (previousDatabasePath === undefined) delete process.env['DATABASE_PATH']
    else process.env['DATABASE_PATH'] = previousDatabasePath
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports liveness before setup and readiness after database initialization', async () => {
    const health = await app.inject('/health')
    assert.equal(health.statusCode, 200)
    assert.deepEqual(health.json(), { status: 'ok' })

    const beforeSetup = await app.inject('/ready')
    assert.equal(beforeSetup.statusCode, 503)
    assert.deepEqual(beforeSetup.json(), { status: 'not_ready', reason: 'setup_required' })

    initDb()
    runMigrations()
    writeSetupComplete()
    const afterSetup = await app.inject('/ready')
    assert.equal(afterSetup.statusCode, 200)
    assert.deepEqual(afterSetup.json(), { status: 'ready' })
  })
})
