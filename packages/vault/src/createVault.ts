import type { FastifyRequest } from 'fastify'
import type { SqliteDatabase } from '@better-kit/db'
import { createHashicorp } from './hashicorp.js'
import { createSecretBox } from './secretBox.js'
import { createSecretResolver } from './resolveSecret.js'
import { createVaultRoutes, type VaultAudit } from './vaultRoutes.js'

export interface VaultOptions {
  /** The application's database handle. It is used lazily, so it may be opened after this is created. */
  db: SqliteDatabase
  audit: VaultAudit
  /** The signed-in caller of a request; the routes sit behind the application's own guards. */
  identity: (req: FastifyRequest) => { userId: number; email: string }
  /** Where the encryption key comes from. Defaults to the process environment. */
  env?: NodeJS.ProcessEnv
}

/**
 * Vaults of secrets (kept encrypted here, or read live from HashiCorp Vault), the lookup that turns a reference into
 * its value, and the routes that manage them. Everything is built from `options` and kept in the returned closures.
 */
export function createVault(options: VaultOptions) {
  const secretBox = createSecretBox(options.env ? { env: options.env } : {})
  const ctx = { db: options.db, secretBox }
  const hashicorp = createHashicorp(ctx)
  const resolver = createSecretResolver(ctx, hashicorp)
  const routes = createVaultRoutes({ ...ctx, audit: options.audit, identity: options.identity }, { hashicorp, resolver })

  return {
    secretBox,
    hashicorp,
    resolver,
    /** Plain plugins, so the hooks of the scope they are registered in apply to them. */
    routes: {
      /** Read-only catalogue of vault and secret names and types, never values. */
      catalogue: routes.vaultCatalogRoutes,
      /** Create, change, reveal and delete vaults and secrets. */
      manage: routes.vaultRoutes,
    },
  }
}

export type Vault = ReturnType<typeof createVault>
