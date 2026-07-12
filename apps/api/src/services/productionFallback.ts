import type { FastifyReply, FastifyRequest } from 'fastify'

export function createProductionFallback(statusDist: string) {
  return (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === '/api' || request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' })
    }
    return reply.sendFile('index.html', statusDist)
  }
}
