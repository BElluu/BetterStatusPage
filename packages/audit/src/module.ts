import type { DbModule } from '@better-forge/db'
import * as tables from './tables.js'
import { auditMigrations } from './migrations.js'

/** The audit log table and its migrations, for the application's list of database modules. */
export const auditDbModule = { id: 'audit', tables, migrations: auditMigrations } satisfies DbModule
