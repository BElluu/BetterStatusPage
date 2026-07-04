import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { requireAuth, requireRole } from '../src/middleware/auth.js'

const app = Fastify({ logger: false })

before(async () => {
  await app.register(jwt, { secret: 'test-secret-with-sufficient-entropy' })
  app.get('/authenticated', { preHandler: requireAuth }, async () => ({ ok: true }))
  app.get('/operator', { preHandler: requireRole('operator') }, async () => ({ ok: true }))
  app.get('/branding', { preHandler: requireRole('operator', 'branding') }, async () => ({ ok: true }))
  app.get('/admin', { preHandler: requireRole() }, async () => ({ ok: true }))
  await app.ready()
})

after(async () => app.close())

function authorization(role: string) {
  const token = app.jwt.sign({ userId: 1, email: `${role}@example.test`, role })
  return { authorization: `Bearer ${token}` }
}

describe('JWT and RBAC middleware', () => {
  it('rejects missing and manipulated tokens', async () => {
    assert.equal((await app.inject({ url: '/authenticated' })).statusCode, 401)
    assert.equal((await app.inject({ url: '/authenticated', headers: { authorization: 'Bearer invalid' } })).statusCode, 401)
  })

  it('allows any valid token through authentication', async () => {
    assert.equal((await app.inject({ url: '/authenticated', headers: authorization('branding') })).statusCode, 200)
  })

  it('enforces role boundaries and admin inheritance', async () => {
    assert.equal((await app.inject({ url: '/operator', headers: authorization('branding') })).statusCode, 403)
    assert.equal((await app.inject({ url: '/operator', headers: authorization('operator') })).statusCode, 200)
    assert.equal((await app.inject({ url: '/branding', headers: authorization('branding') })).statusCode, 200)
    assert.equal((await app.inject({ url: '/admin', headers: authorization('operator') })).statusCode, 403)
    assert.equal((await app.inject({ url: '/admin', headers: authorization('admin') })).statusCode, 200)
  })
})
