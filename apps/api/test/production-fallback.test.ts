import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Fastify from 'fastify'
import { createProductionFallback } from '../src/services/productionFallback.js'

describe('production SPA fallback', () => {
  it('returns JSON 404 for unknown API routes and the status app for frontend routes', async () => {
    const app = Fastify({ logger: false })
    app.decorateReply('sendFile', function (filename: string, root: string) {
      return this.type('text/html').send(`${root}/${filename}`)
    })
    app.setNotFoundHandler(createProductionFallback('/status-dist'))

    try {
      const api = await app.inject({ method: 'GET', url: '/api/v1/unknown' })
      assert.equal(api.statusCode, 404)
      assert.deepEqual(api.json(), { error: 'Not found' })

      const frontend = await app.inject({ method: 'GET', url: '/history/incident-1' })
      assert.equal(frontend.statusCode, 200)
      assert.match(frontend.headers['content-type'] ?? '', /^text\/html/)
      assert.equal(frontend.body, '/status-dist/index.html')
    } finally {
      await app.close()
    }
  })
})
