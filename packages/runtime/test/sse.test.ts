import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { describe, it } from 'node:test'
import Fastify from 'fastify'
import { createSse } from '../src/sse.js'

async function serve(limits: Parameters<typeof createSse>[0]) {
  const { sseService, serveEventStream } = createSse(limits)
  const app = Fastify({ logger: false })
  app.get('/events', (req, reply) => serveEventStream(req, reply))
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as { port: number }
  return { app, sseService, port }
}

/** Opens a stream and never reads from it. */
function openStalled(port: number) {
  const socket = connect(port, '127.0.0.1')
  socket.pause()
  socket.write('GET /events HTTP/1.1\r\nHost: x\r\n\r\n')
  return socket
}

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((r) => setTimeout(r, 20))
}

describe('event stream limits', () => {
  it('refuses streams over the per-address and total limits', async () => {
    const { app, port } = await serve({ maxClientsPerIp: 2, maxClients: 10 })
    const open = [openStalled(port), openStalled(port)]
    try {
      await until(() => app.server.listening && open.length === 2)
      await new Promise((r) => setTimeout(r, 100))
      const third = await fetch(`http://127.0.0.1:${port}/events`)
      assert.equal(third.status, 429)
    } finally {
      open.forEach((s) => s.destroy())
      await app.close()
    }
  })

  it('disconnects a client that does not read', async () => {
    const { app, sseService, port } = await serve({ maxBufferedBytes: 64 * 1024 })
    const socket = openStalled(port)
    try {
      await until(() => sseService.clientCount() === 1)
      assert.equal(sseService.clientCount(), 1)
      const big = 'x'.repeat(256 * 1024)
      for (let i = 0; i < 200 && sseService.clientCount() > 0; i++) sseService.broadcast('monitor.status', big)
      assert.equal(sseService.clientCount(), 0)
    } finally {
      socket.destroy()
      await app.close()
    }
  })
})

describe('event stream limits and sessions', () => {
  it('does not count signed-in streams, so they cannot be locked out by visitors', async () => {
    const { sseService, serveEventStream } = createSse({ maxClientsPerIp: 1, maxClients: 1 })
    const app = Fastify({ logger: false })
    app.get('/events', (req, reply) => serveEventStream(req, reply))
    app.get('/admin-events', (req, reply) => serveEventStream(req, reply, { session: { sessionId: 's', userId: 1 } }))
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    const open = [openStalled(port)]
    try {
      await until(() => sseService.clientCount() === 1)
      assert.equal((await fetch(`http://127.0.0.1:${port}/events`)).status, 429)

      const admin = new AbortController()
      const response = await fetch(`http://127.0.0.1:${port}/admin-events`, { signal: admin.signal })
      assert.equal(response.status, 200)
      admin.abort()
    } finally {
      open.forEach((s) => s.destroy())
      await app.close()
    }
  })
})
