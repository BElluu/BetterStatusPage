import type { DbModule } from '@better-kit/db'
import * as tables from './tables.js'
import { notifyMigrations } from './migrations.js'

/** Notification channels, deliveries and SMTP settings. */
export const notifyModule = { id: 'notify', tables, migrations: notifyMigrations } satisfies DbModule
