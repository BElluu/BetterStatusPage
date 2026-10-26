import type { FastifyReply, FastifyRequest } from 'fastify'
import { rateLimitKey } from './rateLimitKey.js'

type SseClient = FastifyReply

/**
 * Shapes what one client receives: return the data to send (possibly reduced) or `null` to skip the
 * event. Clients without a filter receive everything as broadcast.
 */
export type SseFilter = (event: string, data: unknown) => { data: unknown } | null

export interface ClientInfo {
  filter?: SseFilter | undefined
  /** Set for signed-in streams, so revoking the session can end them. */
  session?: { sessionId: string; userId: number } | undefined
  ip?: string | undefined
}

export interface SseLimits {
  /** Open anonymous streams in total; further ones are refused with 429. Signed-in streams are not counted. */
  maxClients: number
  /** Open anonymous streams from one address (an IPv6 /64 counts as one); further ones are refused with 429. */
  maxClientsPerIp: number
  /** A client with more unsent bytes than this is not reading and gets disconnected. */
  maxBufferedBytes: number
}

const DEFAULT_LIMITS: SseLimits = { maxClients: 1000, maxClientsPerIp: 10, maxBufferedBytes: 1024 * 1024 }

export interface EventStreamOptions {
  filter?: SseFilter
  session?: { sessionId: string; userId: number } | undefined
  /** Re-checked with every keep-alive ping; the stream ends once it resolves to false. */
  stillAllowed?: () => Promise<boolean>
  pingIntervalMs?: number
}

/** Live event streams (server-sent events) to browsers, with per-client filters and session-bound streams. All state is in the returned closure. */
export function createSse(limitOptions: Partial<SseLimits> = {}) {
  const limits = { ...DEFAULT_LIMITS, ...limitOptions }
  const clients = new Map<SseClient, ClientInfo>()

  const listeners = new Set<(event: string) => void>()

  function end(client: SseClient) {
    try { client.raw.end() } catch { /* ignore shutdown races */ }
    try { client.raw.destroy() } catch { /* ignore shutdown races */ }
    clients.delete(client)
  }

  /** Writes to one client and drops it when it cannot keep up, so a stalled reader cannot grow the heap. */
  function send(client: SseClient, chunk: string) {
    try {
      client.raw.write(chunk)
      if (client.raw.writableLength > limits.maxBufferedBytes) end(client)
    } catch {
      clients.delete(client)
    }
  }

  const sseService = {
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
        send(client, shaped.data === data ? payload : format(shaped.data))
      }
    },

    /** Ends the signed-in streams whose session matches, e.g. after the session was revoked. */
    disconnectSessions(match: (session: { sessionId: string; userId: number }) => boolean) {
      for (const [client, { session }] of clients) {
        if (session && match(session)) end(client)
      }
    },

    /** Ends every stream opened without signing in, e.g. once access is restricted to signed-in users. */
    disconnectAnonymous() {
      for (const [client, { session }] of clients) {
        if (!session) end(client)
      }
    },

    closeAll() {
      for (const client of clients.keys()) end(client)
    },

    clientCount() {
      return clients.size
    },
  }

  /** Holds the request open as an event stream until the client disconnects or loses access. */
  async function serveEventStream(req: FastifyRequest, reply: FastifyReply, options: EventStreamOptions = {}): Promise<void> {
    // Only anonymous streams are limited: a signed-in one is accountable, and counting it would let
    // visitors fill the budget the admin stream needs.
    const ip = rateLimitKey(req.ip)
    if (!options.session) {
      let total = 0
      let fromIp = 0
      for (const client of clients.values()) {
        if (client.session) continue
        total++
        if (client.ip === ip) fromIp++
      }
      if (total >= limits.maxClients || fromIp >= limits.maxClientsPerIp) {
        return reply.code(429).send({ error: 'Too many open event streams' })
      }
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.setHeader('X-Accel-Buffering', 'no')
    reply.raw.flushHeaders()

    sseService.add(reply, { filter: options.filter, session: options.session, ip })
    reply.raw.write('event: ping\ndata: {}\n\n')

    const pingInterval = setInterval(() => {
      void (async () => {
        if (options.stillAllowed && !(await options.stillAllowed().catch(() => false))) {
          clearInterval(pingInterval)
          end(reply)
          return
        }
        send(reply, `event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`)
        if (!clients.has(reply)) clearInterval(pingInterval)
      })()
    }, options.pingIntervalMs ?? 30_000)

    req.raw.on('close', () => { clearInterval(pingInterval); sseService.remove(reply) })
    await new Promise<void>((resolve) => { req.raw.on('close', resolve) })
  }

  return { sseService, serveEventStream }
}
