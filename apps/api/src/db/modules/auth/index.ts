import type { DbModule } from '@better-kit/db'
import * as tables from './tables.js'
import { authMigrations } from './migrations.js'

/** Users, sign-in sessions, SSO settings and API tokens. */
export const authModule = { id: 'auth', tables, migrations: authMigrations } satisfies DbModule
