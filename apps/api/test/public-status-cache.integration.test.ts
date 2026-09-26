import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { db, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { incidents } from '../src/db/schema.js'
import { publicRoutes } from '../src/routes/public.js'
import { sseService } from '../src/services/sse.service.js'

const dataDir = mkdtempSync(join(tmpdir(), 'bsp-public-status-cache-test-'))
process.env['DATABASE_PATH'] = join(dataDir, 'test.sqlite')

const app = Fastify({ logger: false })

before(async () => {
  initDb()
  runMigrations()
  await app.register(rateLimit, { global: false })
  await app.register(publicRoutes, { prefix: '/public' })
  await app.ready()
})

after(async () => {
  await app.close()
  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})

async function activeIncidentTitles(): Promise<string[]> {
  const response = await app.inject({ url: '/public/status' })
  assert.equal(response.statusCode, 200)
  return (response.json() as { activeIncidents: Array<{ title: string }> }).activeIncidents.map((incident) => incident.title)
}

async function insertIncident(title: string) {
  const now = Date.now()
  await db.insert(incidents).values({ title, status: 'investigating', impact: 'minor', startedAt: now, createdAt: now, updatedAt: now })
}

describe('public status cache', () => {
  it('serves the short-lived cached copy between changes', async () => {
    assert.deepEqual(await activeIncidentTitles(), [])
    await insertIncident('Written without an event')
    assert.deepEqual(await activeIncidentTitles(), [])
  })

  it('drops the cached copy when an incident event is broadcast', async () => {
    await insertIncident('Announced incident')
    sseService.broadcast('incident.created', {})
    assert.deepEqual((await activeIncidentTitles()).sort(), ['Announced incident', 'Written without an event'])
  })

  it('keeps the cache for monitor status events, which clients apply directly', async () => {
    await activeIncidentTitles()
    await insertIncident('Quiet incident')
    sseService.broadcast('monitor.status', { monitorId: 1, status: 'up' })
    assert.equal((await activeIncidentTitles()).includes('Quiet incident'), false)
  })
})
