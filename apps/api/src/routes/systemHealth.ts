import type { FastifyInstance } from 'fastify'
import { systemHealthRoutes as routes } from '../services/systemHealth.js'

// The routes are built next to the sections of the report; kept so the registration point does not change.
export async function systemHealthRoutes(app: FastifyInstance) {
  await routes(app)
}
