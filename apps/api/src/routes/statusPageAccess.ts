import type { FastifyInstance } from 'fastify'
import type { AdminStatusPageAccess, PublicStatusPageAccess, StatusPageAccessSettings } from '@bsp/shared'
import { db } from '../db/client.js'
import { branding } from '../db/schema.js'
import { requestIdentity } from '../middleware/auth.js'
import { auditActor, diffObjects, writeAudit } from '../services/audit.js'
import { authenticateRequest } from '../services/authSession.js'
import { getOidcConfig } from '../services/oidcSettings.js'
import { getStatusPageAccess, saveStatusPageAccess, StatusPageAccessError } from '../services/statusPageAccess.js'

/** What the status page asks first: whether it must show the sign-in screen, and the branding to show it in. */
export async function publicStatusPageAccessRoutes(app: FastifyInstance) {
  app.get('/access', async (req, reply): Promise<PublicStatusPageAccess> => {
    reply.header('Cache-Control', 'no-store')
    const [settings, identity, brandingRow] = await Promise.all([
      getStatusPageAccess(),
      authenticateRequest(req).catch(() => null),
      db.select().from(branding).then((rows) => rows[0] ?? null),
    ])
    return {
      private: settings.private,
      signedIn: !!identity,
      email: identity?.email ?? null,
      role: identity?.role ?? null,
      passwordChangeRequired: !!identity?.mustChangePassword,
      branding: brandingRow,
    }
  })
}

export async function adminStatusPageAccessRoutes(app: FastifyInstance) {
  async function adminView(settings?: StatusPageAccessSettings): Promise<AdminStatusPageAccess> {
    const [current, oidc] = await Promise.all([settings ?? getStatusPageAccess(), getOidcConfig()])
    return { ...current, ssoConfigured: !!oidc.config }
  }

  app.get('/', async () => adminView())

  app.put<{ Body: Partial<StatusPageAccessSettings> }>('/', async (req, reply) => {
    const before = await getStatusPageAccess()
    let after: StatusPageAccessSettings
    try {
      after = await saveStatusPageAccess(req.body ?? {})
    } catch (error) {
      if (error instanceof StatusPageAccessError) return reply.code(400).send({ error: error.message })
      throw error
    }
    const diff = diffObjects({ ...before }, { ...after })
    if (Object.keys(diff).length) {
      await writeAudit(auditActor(requestIdentity(req)), 'update', 'status_page_access', 1, 'Status page access', diff)
    }
    return adminView(after)
  })
}
