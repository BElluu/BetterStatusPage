import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import cookie from '@fastify/cookie'
import jwt from '@fastify/jwt'
import Fastify from 'fastify'
import { db } from '../src/db/client.js'
import { oidcSettings } from '../src/db/schema.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-oidc-proxy-test-')
process.env['VAULT_ENCRYPTION_KEY'] = 'abcdef0123456789'.repeat(4)
for (const name of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_FORCE_PASSWORD_LOGIN']) delete process.env[name]

describe('SSO discovery through an outbound proxy', () => {
  const requests: string[] = []
  const proxy: Server = createServer((req, res) => {
    requests.push(req.url ?? '')
    res.writeHead(502).end()
  })
  const app = Fastify({ logger: false })

  before(async () => {
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done))
    process.env['HTTP_PROXY'] = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
    initTestDb()
    await app.register(jwt, { secret: 'integration-secret-with-sufficient-entropy' })
    await app.register(cookie)
    // The proxy agent reads the environment when it is created, so the routes are loaded after it is set.
    const { authRoutes } = await import('../src/kit/authRoutes.js')
    await app.register(authRoutes, { prefix: '/auth' })
    await app.ready()
    await db.insert(oidcSettings).values({
      id: 1, enabled: 1, issuer: 'http://idp.proxied.test:8080', clientId: 'bsp', clientSecret: '', scopes: '',
      redirectUri: 'http://127.0.0.1/api/v1/auth/oidc/callback', buttonLabel: '', allowUnverifiedEmail: 0, disablePasswordLogin: 0, updatedAt: Date.now(),
    })
  })

  after(async () => {
    delete process.env['HTTP_PROXY']
    await app.close()
    proxy.closeAllConnections()
    await new Promise((done) => proxy.close(done))
    teardownTestDb(testDb)
  })

  it('sends the discovery request to the proxy instead of connecting to the provider', async () => {
    await app.inject({ url: '/auth/oidc/login' })
    assert.deepEqual(requests, ['http://idp.proxied.test:8080/.well-known/openid-configuration'])
  })
})
