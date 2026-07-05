import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FastifyReply } from 'fastify'
import { sseService } from '../src/services/sse.service.js'

function client(write: (payload: string) => void): FastifyReply {
  return { raw: { write } } as unknown as FastifyReply
}

describe('SSE service', () => {
  it('broadcasts a named JSON event to connected clients', () => {
    const messages: string[] = []
    const reply = client((payload) => { messages.push(payload) })

    sseService.add(reply)
    sseService.broadcast('monitor.status', { monitorId: 7, status: 'up' })
    sseService.remove(reply)

    assert.deepEqual(messages, [
      'event: monitor.status\ndata: {"monitorId":7,"status":"up"}\n\n',
    ])
  })

  it('removes clients that fail during a write', () => {
    const initialCount = sseService.clientCount()
    const reply = client(() => { throw new Error('closed') })

    sseService.add(reply)
    sseService.broadcast('ping', null)

    assert.equal(sseService.clientCount(), initialCount)
  })
})
