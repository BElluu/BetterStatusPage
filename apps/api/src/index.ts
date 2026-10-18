import 'dotenv/config'
import path from 'path'
import { fileURLToPath } from 'url'
import { createBetterApp } from '@better-kit/runtime'
import { isSetupComplete, uploadDir } from './config.js'
import { closeDb, initDb } from './db/client.js'
import { runMigrations } from './db/migrate.js'
import { registerApiRoutes } from './apiRoutes.js'
import { acquireAppLock } from './kit/appLock.js'
import { startBackgroundServices, stopBackgroundServices } from './services/backgroundServices.js'
import { validateEncryptionKey as validateVaultEncryptionKey } from '@better-kit/vault'
import { sseService } from './kit/sse.js'
import { registerProductionFrontends } from './services/productionFallback.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const { run } = await createBetterApp({
  // One-click unsubscribe links carry their capability token in the query string; a heartbeat's `msg` is free text from a job.
  redactQueryParams: ['token', 'msg'],
  // The heartbeat token is the credential of its monitor and sits in the path.
  redactPathTokenPrefixes: ['/api/v1/hook/'],
  validate: validateVaultEncryptionKey,
  uploads: { dir: uploadDir(), maxFileBytes: 5 * 1024 * 1024 },
  // The branding editor previews the status page in a frame of the admin console.
  allowSameOriginFraming: ({ path: requestPath, query }) => requestPath === '/' && query.get('branding-preview') === '1',
  database: { isReady: isSetupComplete, open: initDb, migrate: runMigrations, close: closeDb },
  routes: registerApiRoutes,
  frontends: (app) => registerProductionFrontends(app, path.join(__dirname, '../../admin/dist'), path.join(__dirname, '../../status/dist'), isSetupComplete),
  acquireLock: acquireAppLock,
  stopIntake: () => sseService.closeAll(),
  backgroundServices: { start: startBackgroundServices, stop: stopBackgroundServices },
})

await run()
