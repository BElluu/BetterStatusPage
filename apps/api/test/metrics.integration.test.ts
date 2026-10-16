import assert from 'node:assert/strict'

process.env['UPDATE_CHECK'] = 'false'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import { adminApi } from '../src/adminApi.js'
import { db } from '../src/db/client.js'
import { apiTokens, incidents, monitorResults, monitors } from '../src/db/schema.js'
import { generateApiToken } from '../src/kit/apiTokens.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-metrics-')
const app = Fastify({ logger: false })

async function issue(scopes: string[]) {
  const generated = generateApiToken()
  await db.insert(apiTokens).values({ name: scopes.join(','), tokenHash: generated.hash, prefix: generated.prefix, scopes: JSON.stringify(scopes), createdAt: Date.now() })
  return { authorization: `Bearer ${generated.token}` }
}

before(async () => {
  initTestDb()
  await app.register(cookie)
  await app.register(jwt, { secret: 'test-secret-with-sufficient-entropy' })
  await app.register(multipart)
  await app.register(adminApi, { prefix: '/admin' })
  await app.ready()

  const now = Date.now()
  const [up, down] = await db.insert(monitors).values([
    { name: 'Web "main"', type: 'https', config: '{}', currentStatus: 'up', lastCheckedAt: now, createdAt: now, updatedAt: now },
    { name: 'DB', type: 'postgresql', config: '{}', currentStatus: 'down', lastCheckedAt: now, createdAt: now, updatedAt: now },
    { name: 'New', type: 'ping', config: '{}', createdAt: now, updatedAt: now },
  ]).returning()
  await db.insert(monitorResults).values([
    { monitorId: up!.id, status: 'up', responseMs: 900, checkedAt: now - 1000 },
    { monitorId: up!.id, status: 'up', responseMs: 250, checkedAt: now },
    { monitorId: down!.id, status: 'down', responseMs: null, checkedAt: now },
  ])
  await db.insert(incidents).values([
    { title: 'Open', startedAt: now, createdAt: now, updatedAt: now },
    { title: 'Draft', draft: 1, startedAt: now, createdAt: now, updatedAt: now },
    { title: 'Done', resolvedAt: now, startedAt: now, createdAt: now, updatedAt: now },
  ])
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

describe('GET /admin/metrics', () => {
  it('refuses a request without a token', async () => {
    assert.equal((await app.inject({ url: '/admin/metrics' })).statusCode, 401)
  })

  it('refuses a token without the metrics permission', async () => {
    const response = await app.inject({ url: '/admin/metrics', headers: await issue(['monitors:read']) })
    assert.equal(response.statusCode, 403)
    assert.match(response.json().error, /"metrics:read" permission/)
  })

  it('answers Prometheus text to a token with metrics:read', async () => {
    const response = await app.inject({ url: '/admin/metrics', headers: await issue(['metrics:read']) })
    assert.equal(response.statusCode, 200)
    assert.match(String(response.headers['content-type']), /^text\/plain; version=0\.0\.4/)
    const lines = response.body.split('\n')
    assert.ok(lines.some((line) => /^bsp_monitor_up\{monitor="Web \\"main\\"",key="[^"]+",type="https"\} 1$/.test(line)))
    assert.ok(lines.some((line) => /^bsp_monitor_up\{monitor="DB",.*\} 0$/.test(line)))
    assert.ok(!lines.some((line) => line.startsWith('bsp_monitor_up{monitor="New"')), 'pending monitor has no up sample')
    assert.ok(lines.some((line) => /^bsp_monitor_response_time_seconds\{monitor="Web.*\} 0\.25$/.test(line)), 'latest check wins')
    assert.ok(!lines.some((line) => line.startsWith('bsp_monitor_response_time_seconds{monitor="DB"')))
    assert.ok(lines.includes('bsp_incidents_open 1'), 'drafts and resolved incidents are not open')
  })
})
