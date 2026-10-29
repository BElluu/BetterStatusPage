import type { FastifyInstance } from 'fastify'
import { createSetupRoutes, registerAdminApi } from '@better-forge/auth'
import { withImmediateTransaction } from '@better-forge/db'
import { createHealthRoutes, isSetupComplete, setupConfigPath, writeSetupComplete } from '@better-forge/runtime'
import fs from 'node:fs'
import { db, initDb, migrate, sqlite } from './db.js'
import { audit, auth, backgroundServices, backupRoutes, notifyRoutes, requireAuth, requireRole, vault } from './kit.js'

const setupRoutes = createSetupRoutes({
  db,
  withTransaction: (work) => withImmediateTransaction(sqlite, work),
  isSetupComplete: () => isSetupComplete(),
  writeSetupComplete: () => writeSetupComplete('sqlite'),
  removeSetupMarker: () => fs.rmSync(setupConfigPath(), { force: true }),
  prepareDatabase: () => { initDb(); migrate() },
  createSession: (app, reply, user) => auth.sessions.createAuthSession(app, reply, user),
  rateLimit: { groupId: 'setup', max: 5, timeWindow: '15 minutes' },
  startBackgroundServices: () => backgroundServices.start(),
})

/** Every HTTP route of the template. */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(createHealthRoutes({ db, isSetupComplete: () => isSetupComplete() }))
  await app.register(setupRoutes, { prefix: '/api/v1/setup' })
  await app.register(async (scope) => { await auth.routes.signIn(scope) }, { prefix: '/api/v1/auth' })

  await app.register(async (admin) => {
    await registerAdminApi(admin, {
      authenticate: requireAuth,
      groups: [
        // notification channels, SMTP and delivery history: members and administrators
        { part: 'channels', guard: requireRole('member'), routes: [[notifyRoutes, { prefix: '/notifications' }]] },
        // vault catalogue (names and types only): members and administrators
        { part: 'vault', guard: requireRole('member'), routes: [[async (scope) => { await vault.routes.catalogue(scope) }, { prefix: '/vaults' }]] },
        // audit log: administrators
        { part: 'audit', guard: requireRole(), routes: [[async (scope) => { await audit.routes(scope, {}) }, { prefix: '/audit' }]] },
        // accounts, sign-in, vault management, backups and API tokens: administrators, from a signed-in session only
        {
          noTokens: true, guard: requireRole(),
          routes: [
            [async (scope) => { await auth.routes.users(scope) }, { prefix: '/users' }],
            [async (scope) => { await auth.routes.oidcSettings(scope) }, { prefix: '/oidc' }],
            [async (scope) => { await vault.routes.manage(scope) }, { prefix: '/vaults' }],
            [backupRoutes, { prefix: '/backups' }],
            [async (scope) => { await auth.routes.apiTokens(scope) }, { prefix: '/api-tokens' }],
          ],
        },
      ],
    })
  }, { prefix: '/api/v1/admin' })
}
