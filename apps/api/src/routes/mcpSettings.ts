import type { FastifyInstance } from 'fastify'
import { SENSITIVE_ACTION_RATE_LIMIT } from '../config/rateLimits.js'
import { auditActor, diffObjects, writeAudit } from '../kit/audit.js'
import { auth } from '../kit/auth.js'
import { requestIdentity } from '../kit/authMiddleware.js'
import { resolvePublicUrl } from '../kit/runtime.js'
import { getMcpSettings, saveMcpSettings, type McpSettings } from '../services/mcpSettings.js'

interface McpSettingsView extends McpSettings {
  /** PUBLIC_URL, when set: the address agents should use. */
  publicUrl: string | null
}

/**
 * The switch for the MCP endpoint, in the admin console. Session only (an API token can never turn it on), and turning
 * something on is confirmed like creating a token: with the password, or for an SSO session at the identity provider.
 * Turning something off is the quick way to cut agents off, so it is not asked twice.
 */
export async function adminMcpSettingsRoutes(app: FastifyInstance) {
  const view = (settings: McpSettings): McpSettingsView => ({ ...settings, publicUrl: resolvePublicUrl() || null })

  app.get('/', async () => view(await getMcpSettings()))

  // Like every other route that checks the password: a hijacked session must not get a free password oracle.
  app.put<{ Body: { enabled?: unknown; allowChanges?: unknown; currentPassword?: unknown } }>('/', { config: { rateLimit: SENSITIVE_ACTION_RATE_LIMIT } }, async (req, reply) => {
    const { enabled, allowChanges, currentPassword } = req.body ?? {}
    for (const [name, value] of [['enabled', enabled], ['allowChanges', allowChanges]] as const) {
      if (value !== undefined && typeof value !== 'boolean') return reply.code(400).send({ error: `${name} must be true or false` })
    }
    const before = await getMcpSettings()
    const nextEnabled = typeof enabled === 'boolean' ? enabled : before.enabled
    // Asking for changes while MCP is off is a mistake; the changes simply go off with MCP when it is switched off.
    if (allowChanges === true && !nextEnabled) return reply.code(400).send({ error: 'Turn MCP on before allowing agents to make changes' })
    const next: McpSettings = { enabled: nextEnabled, allowChanges: nextEnabled && (typeof allowChanges === 'boolean' ? allowChanges : before.allowChanges) }

    const turnsSomethingOn = (next.enabled && !before.enabled) || (next.allowChanges && !before.allowChanges)
    if (turnsSomethingOn && !await auth.identityConfirmation.confirmIdentity(requestIdentity(req), currentPassword, reply)) return reply

    // Nothing to change is nothing to write: a stale request must not overwrite a switch someone else just turned off.
    if (next.enabled === before.enabled && next.allowChanges === before.allowChanges) return view(before)
    const after = await saveMcpSettings(next)
    const diff = diffObjects({ ...before }, { ...after })
    if (Object.keys(diff).length) await writeAudit(auditActor(requestIdentity(req)), 'update', 'mcp_settings', 1, 'MCP', diff)
    return view(after)
  })
}
