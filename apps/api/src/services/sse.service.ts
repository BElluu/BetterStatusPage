import type { FastifyReply, FastifyRequest } from 'fastify'

type SseClient = FastifyReply
/**
 * Shapes what one client receives: return the data to send (possibly reduced) or `null` to skip the
 * event. Clients without a filter receive everything as broadcast.
 */
export type SseFilter = (event: string, data: unknown) => { data: unknown } | null

interface ClientInfo {
  filter?: SseFilter | undefined
  /** Set for signed-in streams, so revoking the session can end them. */
  session?: { sessionId: string; userId: number } | undefined
}

const clients = new Map<SseClient, ClientInfo>()
const listeners = new Set<(event: string) => void>()

function end(client: SseClient) {
  try { client.raw.end() } catch { /* ignore shutdown races */ }
  try { client.raw.destroy() } catch { /* ignore shutdown races */ }
  clients.delete(client)
}

export const sseService = {
  add(client: SseClient, info: ClientInfo = {}) {
    clients.set(client, info)
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
    for (const [client, { filter }] of clients) {
      const shaped = filter ? filter(event, data) : { data }
      if (!shaped) continue
      try {
        client.raw.write(shaped.data === data ? payload : format(shaped.data))
      } catch {
        clients.delete(client)
      }
    }
  },

  /** Ends the signed-in streams whose session matches, e.g. after the session was revoked. */
  disconnectSessions(match: (session: { sessionId: string; userId: number }) => boolean) {
    for (const [client, { session }] of clients) {
      if (session && match(session)) end(client)
    }
  },

  closeAll() {
    for (const client of clients.keys()) end(client)
  },

  clientCount() {
    return clients.size
  },
}

export interface EventStreamOptions {
  filter?: SseFilter
  session?: { sessionId: string; userId: number }
  /** Re-checked with every keep-alive ping; the stream ends once it resolves to false. */
  stillAllowed?: () => Promise<boolean>
  pingIntervalMs?: number
}

/** Holds the request open as an event stream until the client disconnects or loses access. */
export async function serveEventStream(req: FastifyRequest, reply: FastifyReply, options: EventStreamOptions = {}): Promise<void> {
  reply.raw.setHeader('Content-Type', 'text/event-stream')
  reply.raw.setHeader('Cache-Control', 'no-cache')
  reply.raw.setHeader('Connection', 'keep-alive')
  reply.raw.setHeader('X-Accel-Buffering', 'no')
  reply.raw.flushHeaders()

  sseService.add(reply, { filter: options.filter, session: options.session })
  reply.raw.write('event: ping\ndata: {}\n\n')

  const pingInterval = setInterval(() => {
    void (async () => {
      if (options.stillAllowed && !(await options.stillAllowed().catch(() => false))) {
        clearInterval(pingInterval)
        end(reply)
        return
      }
      try { reply.raw.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`) }
      catch { clearInterval(pingInterval) }
    })()
  }, options.pingIntervalMs ?? 30_000)

  req.raw.on('close', () => { clearInterval(pingInterval); sseService.remove(reply) })
  await new Promise<void>((resolve) => { req.raw.on('close', resolve) })
}
