import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { LOGIN_RATE_LIMIT, SETUP_RATE_LIMIT, WEBHOOK_RATE_LIMIT } from '../src/config/rateLimits.js'
import { resolveTrustProxy } from '../src/config/proxy.js'

describe('rate limit isolation and proxy handling', () => {
  const app = Fastify({ logger: false, trustProxy: resolveTrustProxy('1') })

  before(async () => {
    await app.register(rateLimit, { global: false })
    app.get('/login', { config: { rateLimit: LOGIN_RATE_LIMIT } }, async () => ({ ok: true }))
    app.get('/setup', { config: { rateLimit: SETUP_RATE_LIMIT } }, async () => ({ ok: true }))
    app.get<{ Params: { token: string } }>('/hook/:token', {
      config: { rateLimit: WEBHOOK_RATE_LIMIT },
    }, async () => ({ ok: true }))
    app.get('/ip', async (req) => ({ ip: req.ip }))
    await app.ready()
  })

  after(() => app.close())

  it('separates route groups and forwarded client IPs', async () => {
    const clientA = { 'x-forwarded-for': '203.0.113.10' }
    for (let i = 0; i < 5; i++) {
      assert.equal((await app.inject({ url: '/setup', headers: clientA })).statusCode, 200)
    }
    assert.equal((await app.inject({ url: '/setup', headers: clientA })).statusCode, 429)
    assert.equal((await app.inject({ url: '/login', headers: clientA })).statusCode, 200)

    const clientB = { 'x-forwarded-for': '203.0.113.11' }
    assert.equal((await app.inject({ url: '/setup', headers: clientB })).statusCode, 200)
  })

  it('trusts a proxy reaching the app over a private (Docker) network but not a public peer', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.30' }
    const viaDocker = await app.inject({ url: '/ip', headers, remoteAddress: '172.18.0.5' })
    assert.equal(viaDocker.json().ip, '203.0.113.30')
    const direct = await app.inject({ url: '/ip', headers, remoteAddress: '198.51.100.7' })
    assert.equal(direct.json().ip, '198.51.100.7')
  })

  it('parses explicit trust proxy settings safely', () => {
    assert.equal(resolveTrustProxy(''), false)
    assert.equal(resolveTrustProxy('false'), false)
    assert.deepEqual(resolveTrustProxy('1'), ['loopback', 'uniquelocal'])
    assert.deepEqual(resolveTrustProxy('172.18.0.0/16'), '172.18.0.0/16')
    assert.deepEqual(resolveTrustProxy('127.0.0.1, ::1'), ['127.0.0.1', '::1'])
  })

  it('limits webhook traffic independently for each monitor token', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.20' }
    const tokenA = 'aa'.repeat(24)
    const tokenB = 'bb'.repeat(24)
    for (let i = 0; i < 60; i++) {
      assert.equal((await app.inject({ url: `/hook/${tokenA}`, headers })).statusCode, 200)
    }
    assert.equal((await app.inject({ url: `/hook/${tokenA}`, headers })).statusCode, 429)
    assert.equal((await app.inject({ url: `/hook/${tokenB}`, headers })).statusCode, 200)
  })
})
