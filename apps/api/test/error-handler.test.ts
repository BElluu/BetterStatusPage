import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { errorHandler } from '../src/errorHandler.js'

const app = Fastify({ logger: false })

before(async () => {
  app.setErrorHandler(errorHandler)
  app.get('/driver-failure', async () => {
    throw new Error('Failed query: insert into "vault_secrets" values (?, ?) params: 1,iv:ciphertext:tag', {
      cause: new Error('UNIQUE constraint failed: vault_secrets.vault_id, vault_secrets.name'),
    })
  })
  app.get('/client-error', async () => {
    throw Object.assign(new Error('Payload too large'), { statusCode: 413 })
  })
  app.post('/json', async () => ({ ok: true }))
  await app.ready()
})

after(() => app.close())

describe('global error handler', () => {
  it('hides the details of unexpected failures', async () => {
    const response = await app.inject({ url: '/driver-failure' })
    assert.equal(response.statusCode, 500)
    assert.deepEqual(response.json(), { error: 'Internal Server Error' })
    assert.doesNotMatch(response.body, /Failed query|ciphertext|UNIQUE/)
  })

  it('keeps client errors readable in the { error } shape', async () => {
    const response = await app.inject({ url: '/client-error' })
    assert.equal(response.statusCode, 413)
    assert.deepEqual(response.json(), { error: 'Payload too large' })

    const malformed = await app.inject({ method: 'POST', url: '/json', headers: { 'content-type': 'application/json' }, payload: '{' })
    assert.equal(malformed.statusCode, 400)
    assert.equal(typeof malformed.json().error, 'string')
  })
})
