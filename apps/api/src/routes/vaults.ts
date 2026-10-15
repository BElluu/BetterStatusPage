import type { FastifyInstance } from 'fastify'
import { vault } from '../kit/vault.js'

// Forwards to the route plugins of the vault module; kept so the registration points do not change.
export async function vaultCatalogRoutes(app: FastifyInstance) {
  await vault.routes.catalogue(app)
}

export async function vaultRoutes(app: FastifyInstance) {
  await vault.routes.manage(app)
}
