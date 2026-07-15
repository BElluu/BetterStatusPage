import type { FastifyInstance } from 'fastify'
import { getSystemHealthReport } from '../services/systemHealth.js'

export async function systemHealthRoutes(app: FastifyInstance) {
  app.get('/', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return getSystemHealthReport()
  })
}
