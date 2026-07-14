import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import Fastify from 'fastify'
import {
  createProductionFallback,
  registerProductionFrontends,
} from '../src/services/productionFallback.js'

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

  it('serves the admin app with and without a trailing slash and supports SPA routes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bsp-production-frontends-'))
    const adminDist = path.join(root, 'admin')
    const statusDist = path.join(root, 'status')
    const app = Fastify({ logger: false })

    try {
      await Promise.all([mkdir(adminDist), mkdir(statusDist)])
      await Promise.all([
        writeFile(path.join(adminDist, 'index.html'), '<h1>Admin app</h1>'),
        writeFile(path.join(statusDist, 'index.html'), '<h1>Status app</h1>'),
      ])
      await registerProductionFrontends(app, adminDist, statusDist)

      const withoutSlash = await app.inject({ method: 'GET', url: '/admin' })
      assert.equal(withoutSlash.statusCode, 302)
      assert.equal(withoutSlash.headers.location, '/admin/')

      const withSlash = await app.inject({ method: 'GET', url: '/admin/' })
      assert.equal(withSlash.statusCode, 200)
      assert.equal(withSlash.body, '<h1>Admin app</h1>')

      const spaRoute = await app.inject({ method: 'GET', url: '/admin/monitors/monitor-1' })
      assert.equal(spaRoute.statusCode, 200)
      assert.equal(spaRoute.body, '<h1>Admin app</h1>')
    } finally {
      await app.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
