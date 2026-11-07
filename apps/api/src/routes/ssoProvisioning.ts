import type { FastifyInstance } from 'fastify'
import { widensSsoProvisioning, type AdminSsoProvisioning, type SsoProvisioningSettings } from '@bsp/shared'
import { SENSITIVE_ACTION_RATE_LIMIT } from '../config/rateLimits.js'
import { auditActor, diffObjects, writeAudit } from '../kit/audit.js'
import { auth } from '../kit/auth.js'
import { requestIdentity } from '../kit/authMiddleware.js'
import { getSsoProvisioning, normalizeSsoProvisioning, saveSsoProvisioning, SsoProvisioningError } from '../services/ssoProvisioning.js'

/**
 * Who a first SSO sign-in from the admin panel creates an account for. Session only, and giving more than before (turning it
 * on, a higher role for a group, a new domain) is confirmed like creating an API token: with the password, or for an SSO
 * session at the identity provider. Turning it down is not asked twice.
 */
export async function adminSsoProvisioningRoutes(app: FastifyInstance) {
  async function view(settings?: SsoProvisioningSettings): Promise<AdminSsoProvisioning> {
    const [current, oidc] = await Promise.all([settings ?? getSsoProvisioning(), auth.oidcSettings.getOidcConfig()])
    return { ...current, ssoConfigured: !!oidc.config }
  }

  app.get('/', async () => view())

  app.put<{ Body: Partial<Record<keyof SsoProvisioningSettings | 'currentPassword', unknown>> }>('/', { config: { rateLimit: SENSITIVE_ACTION_RATE_LIMIT } }, async (req, reply) => {
    const body = req.body ?? {}
    let after: SsoProvisioningSettings
    try {
      after = normalizeSsoProvisioning(body)
    } catch (error) {
      if (error instanceof SsoProvisioningError) return reply.code(400).send({ error: error.message })
      throw error
    }
    const before = await getSsoProvisioning()
    if (widensSsoProvisioning(before, after) && !await auth.identityConfirmation.confirmIdentity(requestIdentity(req), body.currentPassword, reply)) return reply
    await saveSsoProvisioning(after)
    const diff = diffObjects({ ...before }, { ...after })
    if (Object.keys(diff).length) await writeAudit(auditActor(requestIdentity(req)), 'update', 'sso_provisioning', 1, 'SSO account creation', diff)
    return view(after)
  })
}
