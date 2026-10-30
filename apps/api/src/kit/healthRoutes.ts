import type { FastifyInstance } from 'fastify'
import { createHealthRoutes } from '@better-forge/runtime'
import { isSetupComplete } from '../config.js'
import { db } from '../db/client.js'

const routes = createHealthRoutes({ db, isSetupComplete: () => isSetupComplete() })

export async function healthRoutes(app: FastifyInstance) {
  await routes(app)
}
