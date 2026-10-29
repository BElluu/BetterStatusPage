import type { DbModule } from '@better-forge/db'
import * as tables from './tables.js'
import { vaultMigrations } from './migrations.js'

/** The tables of vaults and their secrets, with their migrations, for the application's list of database modules. */
export const vaultDbModule = { id: 'vault', tables, migrations: vaultMigrations } satisfies DbModule
