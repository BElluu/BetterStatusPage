import type { DbModule } from '@better-forge/db'
import * as tables from './tables.js'
import { appMigrations } from './migrations.js'

/** Tables of the application. */
export const appModule = { id: 'app', tables, migrations: appMigrations } satisfies DbModule
