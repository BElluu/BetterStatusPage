import type { FastifyInstance } from 'fastify'
import { renderMetrics } from '../services/metrics.js'

export async function metricsRoutes(app: FastifyInstance) {
  app.get('/', async (_req, reply) => {
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(await renderMetrics())
  })
}
