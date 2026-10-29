import type { DbModule } from '@better-forge/db'
import { authDbModule } from '@better-forge/auth'
import { auditDbModule } from '@better-forge/audit'
import { vaultDbModule } from '@better-forge/vault'
import { notifyModule } from './notify/index.js'
import { appModule } from './app/index.js'

/** In the order they run: a module may rely on the tables of the ones before it. */
export const dbModules: readonly DbModule[] = [authDbModule, auditDbModule, vaultDbModule, notifyModule, appModule]
