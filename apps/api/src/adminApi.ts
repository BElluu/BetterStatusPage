import type { FastifyInstance } from 'fastify'
import { requireAuth, requireRole } from './middleware/auth.js'
import { oidcSettingsRoutes } from './routes/oidcSettings.js'
import { monitorRoutes } from './routes/monitors.js'
import { incidentRoutes } from './routes/incidents.js'
import { layoutRoutes } from './routes/layout.js'
import { brandingRoutes } from './routes/branding.js'
import { userRoutes } from './routes/users.js'
import { vaultCatalogRoutes, vaultRoutes } from './routes/vaults.js'
import { notificationRoutes } from './routes/notifications.js'
import { maintenanceRoutes } from './routes/maintenance.js'
import { auditRoutes } from './routes/audit.js'
import { adminLocaleRoutes } from './routes/locales.js'
import { adminSubscriberRoutes } from './routes/subscriptions.js'
import { adminStatusPageAccessRoutes } from './routes/statusPageAccess.js'
import { backupRoutes } from './routes/backups.js'
import { apiTokenRoutes } from './routes/apiTokens.js'
import { configRoutes } from './routes/config.js'
import { systemHealthRoutes } from './routes/systemHealth.js'
import { reportRoutes } from './routes/reports.js'

/**
 * Everything under `/api/v1/admin`. Registered by index.ts; kept in its own module so a test can build the real
 * route tree and check which routes accept an API token.
 */
export async function adminApi(adminApp: FastifyInstance) {
  // The admin API is what scripts and CI call with an API token; the group below that manages accounts and
  // credentials opts out again. Routes outside this scope never accept a token.
  adminApp.addHook('onRoute', (route) => { route.config = { ...route.config, allowApiToken: true } })
  adminApp.addHook('preHandler', requireAuth)

  // monitors: operator+
  await adminApp.register(async (sub) => {
    sub.addHook('preHandler', requireRole('operator'))
    await sub.register(monitorRoutes, { prefix: '/monitors' })
  })

  // incidents: operator+
  await adminApp.register(async (sub) => {
    sub.addHook('preHandler', requireRole('operator'))
    await sub.register(incidentRoutes, { prefix: '/incidents' })
  })

  // layout, branding & locales: branding+
  await adminApp.register(async (sub) => {
    sub.addHook('preHandler', requireRole('operator', 'branding'))
    await sub.register(layoutRoutes,      { prefix: '/layout' })
    await sub.register(brandingRoutes,    { prefix: '/branding' })
    await sub.register(adminLocaleRoutes, { prefix: '/locales' })
  })

  // notifications: operator+
  await adminApp.register(async (sub) => {
    sub.addHook('preHandler', requireRole('operator'))
    await sub.register(notificationRoutes, { prefix: '/notifications' })
    await sub.register(adminSubscriberRoutes, { prefix: '/subscribers' })
    await sub.register(reportRoutes, { prefix: '/reports' })
  })

  // maintenance windows: operator+
  await adminApp.register(async (sub) => {
    sub.addHook('preHandler', requireRole('operator'))
    await sub.register(maintenanceRoutes, { prefix: '/maintenance' })
  })

  // vault catalogue (names and types only, for picking a secret in a monitor): operator+
  await adminApp.register(async (sub) => {
    sub.addHook('preHandler', requireRole('operator'))
    await sub.register(vaultCatalogRoutes, { prefix: '/vaults' })
  })

  // audit log, system health & config export: admin only
  await adminApp.register(async (sub) => {
    sub.addHook('preHandler', requireRole())  // only admin passes (no allowed list)
    await sub.register(auditRoutes,  { prefix: '/audit' })
    await sub.register(systemHealthRoutes, { prefix: '/system-health' })
    await sub.register(configRoutes, { prefix: '/config' })
  })

  // accounts, sign-in, who may view the page, vault management, backups & API tokens: admin only, and only from a
  // signed-in session. A leaked token must not be able to mint another one, reset a password, let SSO users in,
  // or read a secret or the database.
  await adminApp.register(async (sub) => {
    sub.addHook('onRoute', (route) => { route.config = { ...route.config, allowApiToken: false } })
    sub.addHook('preHandler', requireRole())
    await sub.register(userRoutes,   { prefix: '/users' })
    await sub.register(oidcSettingsRoutes, { prefix: '/oidc' })
    await sub.register(adminStatusPageAccessRoutes, { prefix: '/status-page-access' })
    await sub.register(vaultRoutes,  { prefix: '/vaults' })
    await sub.register(backupRoutes, { prefix: '/backups' })
    await sub.register(apiTokenRoutes, { prefix: '/api-tokens' })
  })
}
