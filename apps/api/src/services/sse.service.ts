import type { FastifyReply, FastifyRequest } from 'fastify'

type SseClient = FastifyReply
/**
 * Shapes what one client receives: return the data to send (possibly reduced) or `null` to skip the
 * event. Clients without a filter receive everything as broadcast.
 */
export type SseFilter = (event: string, data: unknown) => { data: unknown } | null

const clients = new Map<SseClient, SseFilter | undefined>()
const listeners = new Set<(event: string) => void>()

export const sseService = {
  add(client: SseClient, filter?: SseFilter) {
    clients.set(client, filter)
  },

  remove(client: SseClient) {
    clients.delete(client)
  },

  /** Server-side hook for anything that must react to the same events clients receive. */
  onBroadcast(listener: (event: string) => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },

  broadcast(event: string, data: unknown) {
    for (const listener of listeners) listener(event)
    const format = (value: unknown) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`
    const payload = format(data)
    for (const [client, filter] of clients) {
      const shaped = filter ? filter(event, data) : { data }
      if (!shaped) continue
      try {
        client.raw.write(shaped.data === data ? payload : format(shaped.data))
      } catch {
        clients.delete(client)
      }
    }
  },

  closeAll() {
    for (const client of clients.keys()) {
      try { client.raw.end() } catch { /* ignore shutdown races */ }
      try { client.raw.destroy() } catch { /* ignore shutdown races */ }
      clients.delete(client)
    }
  },

  clientCount() {
    return clients.size
  },
}

/** Holds the request open as an event stream until the client disconnects. */
export async function serveEventStream(req: FastifyRequest, reply: FastifyReply, filter?: SseFilter): Promise<void> {
  reply.raw.setHeader('Content-Type', 'text/event-stream')
  reply.raw.setHeader('Cache-Control', 'no-cache')
  reply.raw.setHeader('Connection', 'keep-alive')
  reply.raw.setHeader('X-Accel-Buffering', 'no')
  reply.raw.flushHeaders()

  sseService.add(reply, filter)
  reply.raw.write('event: ping\ndata: {}\n\n')

  const pingInterval = setInterval(() => {
    try { reply.raw.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`) }
    catch { clearInterval(pingInterval) }
  }, 30000)

  req.raw.on('close', () => { clearInterval(pingInterval); sseService.remove(reply) })
  await new Promise<void>((resolve) => { req.raw.on('close', resolve) })
}
