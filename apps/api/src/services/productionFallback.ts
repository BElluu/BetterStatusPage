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

/** Paths the status app does not own: they keep answering while the first-run setup is pending. */
const NOT_STATUS_APP = /^\/(api|admin|uploads|health|ready)(\/|\?|$)/

export async function registerProductionFrontends(
  app: FastifyInstance,
  adminDist: string,
  statusDist: string,
  isSetupComplete: () => boolean,
): Promise<void> {
  // Before the setup there is no database, so the status app has nothing to show: send the visitor to the setup wizard.
  app.addHook('onRequest', async (request, reply) => {
    if ((request.method === 'GET' || request.method === 'HEAD') && !NOT_STATUS_APP.test(request.url) && !isSetupComplete()) {
      return reply.redirect('/admin/')
    }
  })

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
