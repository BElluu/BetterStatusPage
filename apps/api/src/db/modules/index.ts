import type { DbModule } from '@better-kit/db'
import { authModule } from './auth/index.js'
import { auditDbModule } from '@better-kit/audit'
import { vaultModule } from './vault/index.js'
import { notifyModule } from './notify/index.js'
import { appModule } from './app/index.js'

/** In the order they run: a module may rely on the tables of the ones before it. */
export const dbModules: readonly DbModule[] = [authModule, auditDbModule, vaultModule, notifyModule, appModule]
