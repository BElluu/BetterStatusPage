import type { FastifyInstance } from 'fastify'
import { auth } from './auth.js'

// Forwards to the route plugin of the auth package; kept so the registration points do not change.
export async function authRoutes(app: FastifyInstance) {
  await auth.routes.signIn(app)
}
