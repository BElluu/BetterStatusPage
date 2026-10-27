import staticFiles from '@fastify/static'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * A built file that is not there (a script or stylesheet of an earlier build) must not be answered with the app's
 * page: the browser would take the HTML for the script, and the cause would read as a syntax or MIME error.
 */
const MISSING_ASSET = /^(\/admin)?\/assets\//

export function createProductionFallback(statusDist: string) {
  return (request: FastifyRequest, reply: FastifyReply) => {
    // /mcp is an endpoint while MCP is switched on in the admin console; when it is off, it must not turn into the status page.
    if (/^\/(api|mcp)(\/|\?|$)/.test(request.url)) {
      return reply.code(404).send({ error: 'Not found' })
    }
    if (MISSING_ASSET.test(request.url)) return reply.code(404).type('text/plain').send('Not found')
    return reply.sendFile('index.html', statusDist)
  }
}

/** Paths the status app does not own: they keep answering while the first-run setup is pending. */
const NOT_STATUS_APP = /^\/(api|mcp|admin|uploads|health|ready)(\/|\?|$)/

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
  app.get('/admin/*', (request, reply) => {
    if (MISSING_ASSET.test(request.url)) return reply.code(404).type('text/plain').send('Not found')
    return reply.sendFile('index.html', adminDist)
  })

  await app.register(staticFiles, {
    root: statusDist,
    prefix: '/',
    decorateReply: false,
  })

  app.setNotFoundHandler(createProductionFallback(statusDist))
}
