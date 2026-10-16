import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import staticFiles from '@fastify/static'
import { createBetterApp, dataDir, isSetupComplete } from '@better-kit/runtime'
import { closeDb, initDb, migrate } from './db.js'
import { appLock, backgroundServices } from './kit.js'
import { registerRoutes } from './routes.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const webDist = path.resolve(here, '../web')

const { run } = await createBetterApp({
  logName: 'Template',
  uploads: { dir: path.join(dataDir(), 'uploads'), maxFileBytes: 5 * 1024 * 1024 },
  database: { isReady: isSetupComplete, open: initDb, migrate, close: closeDb },
  routes: registerRoutes,
  // The built web interface is served from the root; any other path that is not the API shows it, so deep links work.
  frontends: async (app) => {
    await app.register(staticFiles, { root: webDist, prefix: '/', wildcard: false })
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' })
      return reply.sendFile('index.html')
    })
  },
  acquireLock: appLock.acquireAppLock,
  backgroundServices,
})

await run()
