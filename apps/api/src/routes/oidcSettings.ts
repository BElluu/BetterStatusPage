import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { oidcSettings, users } from '../db/schema.js'
import { encrypt } from '../crypto/vault.js'
import { SENSITIVE_ACTION_RATE_LIMIT } from '../config/rateLimits.js'
import { buildOidcConfig, defaultOidcRedirectUri, type OidcConfig } from '../config/oidc.js'
import { requestIdentity } from '../middleware/auth.js'
import { auditActor, diffObjects, writeAudit } from '../services/audit.js'
import { testOidcDiscovery } from '../services/oidc.js'
import { getOidcConfig, getOidcSettingsRow, oidcConfigFromRow, type OidcSettingsRow } from '../services/oidcSettings.js'

interface SettingsBody {
  enabled?: boolean
  issuer?: string
  clientId?: string
  /** Non-empty replaces the stored secret; omitted or empty keeps it. */
  clientSecret?: string
  clearClientSecret?: boolean
  scopes?: string
  redirectUri?: string
  buttonLabel?: string
  allowUnverifiedEmail?: boolean
  disablePasswordLogin?: boolean
  currentPassword?: string
}

function publicView(row: OidcSettingsRow | null) {
  return {
    enabled: !!row?.enabled,
    issuer: row?.issuer ?? '',
    clientId: row?.clientId ?? '',
    hasClientSecret: !!row?.clientSecret,
    scopes: row?.scopes ?? '',
    redirectUri: row?.redirectUri ?? '',
    buttonLabel: row?.buttonLabel ?? '',
    allowUnverifiedEmail: !!row?.allowUnverifiedEmail,
    disablePasswordLogin: !!row?.disablePasswordLogin,
  }
}

/** Fields that appear in the audit diff; the secret is only recorded as changed, never its value. */
function auditView(row: OidcSettingsRow | null, secretChanged = false) {
  const { hasClientSecret: _has, ...rest } = publicView(row)
  return { ...rest, clientSecretChanged: secretChanged }
}

async function discoveryError(config: OidcConfig): Promise<string | null> {
  try {
    await testOidcDiscovery(config)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'Discovery failed'
  }
}

export async function oidcSettingsRoutes(app: FastifyInstance) {
  app.get('/', async () => {
    const [row, active] = await Promise.all([getOidcSettingsRow(), getOidcConfig()])
    return {
      source: active.source,
      envManaged: active.source === 'env',
      defaultRedirectUri: defaultOidcRedirectUri(),
      settings: publicView(row),
    }
  })

  app.put<{ Body: SettingsBody }>('/', { config: { rateLimit: SENSITIVE_ACTION_RATE_LIMIT } }, async (req, reply) => {
    if ((await getOidcConfig()).source === 'env') {
      return reply.code(409).send({ error: 'OIDC is configured through environment variables and cannot be changed here' })
    }
    const body = req.body ?? {}
    const identity = requestIdentity(req)
    const admin = (await db.select().from(users).where(eq(users.id, identity.userId)))[0]
    if (!body.currentPassword || !admin || !await bcrypt.compare(body.currentPassword, admin.passwordHash)) {
      return reply.code(400).send({ error: 'Current password is incorrect' })
    }

    const previous = await getOidcSettingsRow()
    const secretChanged = !!body.clearClientSecret || !!body.clientSecret?.trim()
    const clientSecret = body.clearClientSecret
      ? ''
      : body.clientSecret?.trim() ? encrypt(body.clientSecret.trim()) : previous?.clientSecret ?? ''
    const next: OidcSettingsRow = {
      id: 1,
      enabled: body.enabled ? 1 : 0,
      issuer: (body.issuer ?? '').trim(),
      clientId: (body.clientId ?? '').trim(),
      clientSecret,
      scopes: (body.scopes ?? '').trim(),
      redirectUri: (body.redirectUri ?? '').trim(),
      buttonLabel: (body.buttonLabel ?? '').trim(),
      allowUnverifiedEmail: body.allowUnverifiedEmail ? 1 : 0,
      disablePasswordLogin: body.disablePasswordLogin ? 1 : 0,
      updatedAt: Date.now(),
    }

    if (next.enabled) {
      const config = oidcConfigFromRow(next)
      if (!config) {
        return reply.code(400).send({ error: 'Issuer URL, client ID and a redirect URI (or PUBLIC_URL) are required and must be valid http(s) URLs' })
      }
      // Never persist a setup that could lock everyone out: with password login off, the IdP must be reachable.
      if (config.disablePasswordLogin) {
        const failure = await discoveryError(config)
        if (failure) return reply.code(400).send({ error: `Password sign-in can only be disabled after OIDC discovery succeeds: ${failure}` })
      }
    } else {
      next.disablePasswordLogin = 0
    }

    await db.insert(oidcSettings).values(next).onConflictDoUpdate({ target: oidcSettings.id, set: { ...next } })
    await writeAudit(auditActor(identity), previous ? 'update' : 'create', 'oidc_settings', 1, 'OIDC sign-in',
      diffObjects(auditView(previous), auditView(next, secretChanged)))
    return publicView(next)
  })

  app.post<{ Body: SettingsBody }>('/test', { config: { rateLimit: SENSITIVE_ACTION_RATE_LIMIT } }, async (req, reply) => {
    const body = req.body ?? {}
    const config = buildOidcConfig({
      issuer: body.issuer,
      clientId: body.clientId,
      redirectUri: body.redirectUri,
    })
    if (!config) return reply.code(400).send({ error: 'Enter a valid issuer URL, client ID and a redirect URI (or set PUBLIC_URL)' })
    const failure = await discoveryError(config)
    if (failure) return reply.code(400).send({ error: `Discovery failed: ${failure}` })
    return { ok: true, ...(await testOidcDiscovery(config)) }
  })
}
