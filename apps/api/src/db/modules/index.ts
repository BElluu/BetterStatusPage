import type { DbModule } from '@better-kit/db'
import { authDbModule } from '@better-kit/auth'
import { auditDbModule } from '@better-kit/audit'
import { vaultModule } from './vault/index.js'
import { notifyModule } from './notify/index.js'
import { appModule } from './app/index.js'

/** In the order they run: a module may rely on the tables of the ones before it. */
export const dbModules: readonly DbModule[] = [authDbModule, auditDbModule, vaultModule, notifyModule, appModule]
