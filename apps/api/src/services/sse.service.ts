import type { FastifyReply } from 'fastify'

type SseClient = FastifyReply

const clients = new Set<SseClient>()

export const sseService = {
  add(client: SseClient) {
    clients.add(client)
  },

  remove(client: SseClient) {
    clients.delete(client)
  },

  broadcast(event: string, data: unknown) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of clients) {
      try {
        client.raw.write(payload)
      } catch {
        clients.delete(client)
      }
    }
  },

  clientCount() {
    return clients.size
  },
}
