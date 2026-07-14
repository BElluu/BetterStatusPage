import staticFiles from '@fastify/static'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

export function createProductionFallback(statusDist: string) {
  return (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === '/api' || request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' })
    }
    return reply.sendFile('index.html', statusDist)
  }
}

export async function registerProductionFrontends(
  app: FastifyInstance,
  adminDist: string,
  statusDist: string,
): Promise<void> {
  await app.register(staticFiles, {
    root: adminDist,
    prefix: '/admin/',
    wildcard: false,
  })

  app.get('/admin', (_, reply) => reply.redirect('/admin/'))
  app.get('/admin/*', (_, reply) => reply.sendFile('index.html', adminDist))

  await app.register(staticFiles, {
    root: statusDist,
    prefix: '/',
    decorateReply: false,
  })

  app.setNotFoundHandler(createProductionFallback(statusDist))
}
