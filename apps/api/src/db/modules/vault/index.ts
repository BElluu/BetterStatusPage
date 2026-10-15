import type { DbModule } from '@better-kit/db'
import * as tables from './tables.js'
import { vaultMigrations } from './migrations.js'

/** Vaults and the secrets in them. */
export const vaultModule = { id: 'vault', tables, migrations: vaultMigrations } satisfies DbModule
