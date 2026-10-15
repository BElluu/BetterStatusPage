import type { FastifyInstance } from 'fastify'
import { auth } from '../kit/auth.js'

// Forwards to the route plugin of the auth package; kept so the registration points do not change.
export async function oidcSettingsRoutes(app: FastifyInstance) {
  await auth.routes.oidcSettings(app)
}
