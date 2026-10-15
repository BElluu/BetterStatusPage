import type { DbModule } from '@better-kit/db'
import * as tables from './tables.js'
import { auditMigrations } from './migrations.js'

/** The audit log. */
export const auditModule = { id: 'audit', tables, migrations: auditMigrations } satisfies DbModule
