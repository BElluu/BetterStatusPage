import type { FastifyInstance } from 'fastify'
import { getSystemHealthReport } from '../services/systemHealth.js'
import { getAvailableUpdate } from '../services/updateCheck.js'
import { resolveAppVersion } from '../version.js'

export async function systemHealthRoutes(app: FastifyInstance) {
  app.get('/', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return getSystemHealthReport()
  })

  /** Only the running version and a newer release, if any: cheap enough for the dashboard to ask on every visit. */
  app.get('/update', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return { version: resolveAppVersion(), update: getAvailableUpdate() }
  })
}
