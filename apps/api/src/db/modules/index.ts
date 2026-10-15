import { authModule } from './auth/index.js'
import { auditModule } from './audit/index.js'
import { vaultModule } from './vault/index.js'
import { notifyModule } from './notify/index.js'
import { appModule } from './app/index.js'

/** In the order they run: a module may rely on the tables of the ones before it. */
export const dbModules = [authModule, auditModule, vaultModule, notifyModule, appModule] as const
