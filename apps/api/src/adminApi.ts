import type { FastifyInstance } from 'fastify'
import { registerAdminApi } from '@better-kit/auth'
import { requireAuth, requireRole } from './middleware/auth.js'
import { oidcSettingsRoutes } from './routes/oidcSettings.js'
import { monitorRoutes } from './routes/monitors.js'
import { incidentRoutes } from './routes/incidents.js'
import { incidentTemplateRoutes } from './routes/incidentTemplates.js'
import { layoutRoutes } from './routes/layout.js'
import { brandingRoutes } from './routes/branding.js'
import { userRoutes } from './routes/users.js'
import { vaultCatalogRoutes, vaultRoutes } from './routes/vaults.js'
import { notificationRoutes } from './routes/notifications.js'
import { actionRoutes } from './routes/actions.js'
import { maintenanceRoutes } from './routes/maintenance.js'
import { auditRoutes } from './routes/audit.js'
import { adminLocaleRoutes } from './routes/locales.js'
import { adminSubscriberRoutes } from './routes/subscriptions.js'
import { adminStatusPageAccessRoutes } from './routes/statusPageAccess.js'
import { backupRoutes } from './kit/backupRoutes.js'
import { apiTokenRoutes } from './routes/apiTokens.js'
import { configRoutes } from './kit/configRoutes.js'
import { systemHealthRoutes } from './routes/systemHealth.js'
import { reportRoutes } from './routes/reports.js'
import { metricsRoutes } from './routes/metrics.js'

/**
 * Everything under `/api/v1/admin`. Registered by index.ts; kept in its own module so a test can build the real
 * route tree and check which routes accept an API token and which permission they need.
 *
 * The admin API is what scripts and CI call with an API token; the last group, which manages accounts and credentials,
 * opts out again. Routes outside this scope never accept a token.
 */
export async function adminApi(adminApp: FastifyInstance) {
  await registerAdminApi(adminApp, {
    authenticate: requireAuth,
    groups: [
      // monitors: operator+
      { part: 'monitors', guard: requireRole('operator'), routes: [[monitorRoutes, { prefix: '/monitors' }]] },
      // incidents: operator+
      {
        part: 'incidents', guard: requireRole('operator'),
        routes: [[incidentRoutes, { prefix: '/incidents' }], [incidentTemplateRoutes, { prefix: '/incident-templates' }]],
      },
      // layout, branding & locales: branding+
      {
        part: 'appearance', guard: requireRole('operator', 'branding'),
        routes: [[layoutRoutes, { prefix: '/layout' }], [brandingRoutes, { prefix: '/branding' }], [adminLocaleRoutes, { prefix: '/locales' }]],
      },
      // notification channels, SMTP and delivery history: operator+
      { part: 'channels', guard: requireRole('operator'), routes: [[notificationRoutes, { prefix: '/notifications' }]] },
      // actions run requests when a monitor changes state, so only admins manage them
      { part: 'actions', guard: requireRole(), routes: [[actionRoutes, { prefix: '/actions' }]] },
      // subscribers: operator+
      { part: 'subscribers', guard: requireRole('operator'), routes: [[adminSubscriberRoutes, { prefix: '/subscribers' }]] },
      // reports: operator+
      { part: 'reports', guard: requireRole('operator'), routes: [[reportRoutes, { prefix: '/reports' }]] },
      // maintenance windows: operator+
      { part: 'maintenance', guard: requireRole('operator'), routes: [[maintenanceRoutes, { prefix: '/maintenance' }]] },
      // vault catalogue (names and types only, for picking a secret in a monitor): operator+. A token needs the
      // permission to use vault secrets to see even the names.
      { part: 'vault', guard: requireRole('operator'), routes: [[vaultCatalogRoutes, { prefix: '/vaults' }]] },
      // audit log: admin only (no allowed list)
      { part: 'audit', guard: requireRole(), routes: [[auditRoutes, { prefix: '/audit' }]] },
      // system health: admin only
      { part: 'system', guard: requireRole(), routes: [[systemHealthRoutes, { prefix: '/system-health' }]] },
      // Prometheus metrics: admin only (a scrape token carries `metrics:read`)
      { part: 'metrics', guard: requireRole(), routes: [[metricsRoutes, { prefix: '/metrics' }]] },
      // configuration export and import: the handler checks what the caller may do with each kind of object
      { part: 'custom', guard: requireRole('operator'), routes: [[configRoutes, { prefix: '/config' }]] },
      // accounts, sign-in, who may view the page, vault management, backups & API tokens: admin only, and only from a
      // signed-in session. A leaked token must not be able to mint another one, reset a password, let SSO users in,
      // or read a secret or the database.
      {
        noTokens: true, guard: requireRole(),
        routes: [
          [userRoutes, { prefix: '/users' }],
          [oidcSettingsRoutes, { prefix: '/oidc' }],
          [adminStatusPageAccessRoutes, { prefix: '/status-page-access' }],
          [vaultRoutes, { prefix: '/vaults' }],
          [backupRoutes, { prefix: '/backups' }],
          [apiTokenRoutes, { prefix: '/api-tokens' }],
        ],
      },
    ],
  })
}
