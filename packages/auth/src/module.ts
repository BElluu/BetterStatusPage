import type { DbModule } from '@better-kit/db'
import * as tables from './tables.js'
import { authMigrations } from './migrations.js'

/** The tables of accounts, sessions, API tokens and SSO settings, with their migrations, for the application's list of database modules. */
export const authDbModule = { id: 'auth', tables, migrations: authMigrations } satisfies DbModule
