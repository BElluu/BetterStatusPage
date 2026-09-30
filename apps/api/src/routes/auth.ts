import type { FastifyInstance, FastifyReply } from 'fastify'
import bcrypt from 'bcryptjs'
import QRCode from 'qrcode'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { LOGIN_RATE_LIMIT } from '../config/rateLimits.js'
import { decrypt, encrypt } from '../crypto/vault.js'
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  totpUri,
  verifyTotp,
} from '../crypto/totp.js'
import { ALLOW_PENDING_PASSWORD_CHANGE, requestIdentity, requireAuth } from '../middleware/auth.js'
import {
  clearAuthCookies,
  createAuthSession,
  revokeSession,
  revokeUserSessions,
  type AuthIdentity,
  type AuthMethod,
} from '../services/authSession.js'
import { writeAudit } from '../services/audit.js'
import { verifySecondFactor } from '../services/twoFactor.js'
import { passwordLoginEnabled, type OidcConfig } from '../config/oidc.js'
import { getOidcConfig, getOidcTestConfig } from '../services/oidcSettings.js'
import {
  auditOidcDenial,
  beginOidcLogin,
  evaluateOidcClaims,
  exchangeOidcCode,
  linkOidcIdentity,
  runOidcTest,
  storeOidcTestResult,
  type OidcDenialCode,
  type OidcFlowState,
} from '../services/oidc.js'

const OIDC_FLOW_COOKIE = 'bsp_oidc_flow'
const OIDC_FLOW_PATH = '/api/v1/auth/oidc'
const OIDC_FLOW_SECONDS = 10 * 60
const OIDC_FAILED_REDIRECT = '/admin/login?error=oidc_failed'
// Denials about the identity itself show "no account matches"; the rest show the generic failure.
const ACCOUNT_DENIALS = new Set<OidcDenialCode>(['no_email_claim', 'email_not_verified', 'no_matching_account', 'subject_mismatch'])
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000)

interface OidcFlowClaims extends OidcFlowState {
  /** 'oidc-flow' signs a user in; 'oidc-test' only reports the outcome to the administrator who started it. */
  purpose?: 'oidc-flow' | 'oidc-test'
  adminUserId?: number
}

/** Redirects to the provider, keeping the PKCE verifier, state and nonce in a short-lived signed cookie. */
export async function startOidcFlow(
  app: FastifyInstance, reply: FastifyReply, cfg: OidcConfig,
  extra: Pick<OidcFlowClaims, 'purpose' | 'adminUserId'>,
) {
  const { url, flow } = await beginOidcLogin(cfg)
  reply.setCookie(OIDC_FLOW_COOKIE, app.jwt.sign({ ...extra, ...flow }, { expiresIn: OIDC_FLOW_SECONDS }), {
    path: OIDC_FLOW_PATH,
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    // Lax, not Strict: the IdP redirects back from another site and Strict cookies are not sent then.
    sameSite: 'lax',
    maxAge: OIDC_FLOW_SECONDS,
  })
  return reply.redirect(url)
}

function callbackUrlFor(cfg: OidcConfig, query: URLSearchParams): URL {
  const url = new URL(cfg.redirectUri)
  url.search = query.toString()
  return url
}

function publicSession(identity: AuthIdentity) {
  const { sessionId: _sessionId, ...safe } = identity
  return safe
}

async function verifyPassword(user: typeof users.$inferSelect, password: string): Promise<boolean> {
  return bcrypt.compare(password, user.passwordHash)
}

async function finishLogin(app: FastifyInstance, reply: FastifyReply, user: typeof users.$inferSelect, authMethod: AuthMethod = 'password') {
  const identity = await createAuthSession(app, reply, user, authMethod)
  return publicSession(identity)
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/config', async () => {
    const { config } = await getOidcConfig()
    return { passwordLogin: passwordLoginEnabled(config), oidc: config ? { label: config.buttonLabel } : null }
  })

  app.get('/oidc/login', { config: { rateLimit: LOGIN_RATE_LIMIT } }, async (req, reply) => {
    const { config: cfg } = await getOidcConfig()
    if (!cfg) return reply.code(404).send({ error: 'OIDC is not configured' })
    try {
      return await startOidcFlow(app, reply, cfg, { purpose: 'oidc-flow' })
    } catch (error) {
      req.log.error({ err: error }, 'OIDC discovery failed')
      await auditOidcDenial(cfg, { code: 'discovery_failed', reason: `OIDC discovery against the issuer failed: ${errorText(error)}` })
      return reply.redirect(OIDC_FAILED_REDIRECT)
    }
  })

  app.get('/oidc/callback', { config: { rateLimit: LOGIN_RATE_LIMIT } }, async (req, reply) => {
    const token = req.cookies[OIDC_FLOW_COOKIE]
    reply.clearCookie(OIDC_FLOW_COOKIE, { path: OIDC_FLOW_PATH })
    const query = new URL(req.url, 'http://localhost').searchParams
    let flow: OidcFlowClaims | null = null
    try {
      if (token) flow = app.jwt.verify<OidcFlowClaims>(token)
    } catch { /* expired or tampered: handled as missing */ }

    if (flow?.purpose === 'oidc-test' && Number.isInteger(flow.adminUserId)) {
      const cfg = await getOidcTestConfig()
      if (!cfg) return reply.code(404).send({ error: 'OIDC is not configured' })
      const result = await runOidcTest(cfg, callbackUrlFor(cfg, query), flow)
      return reply.redirect(`/admin/sso-test?result=${storeOidcTestResult(flow.adminUserId!, result)}`)
    }

    const { config: cfg } = await getOidcConfig()
    if (!cfg) return reply.code(404).send({ error: 'OIDC is not configured' })
    if (flow?.purpose !== 'oidc-flow') {
      // Only audited for what looks like a real provider redirect: anyone can open the callback URL.
      if (query.has('state')) {
        await auditOidcDenial(cfg, {
          code: 'flow_expired',
          reason: 'The sign-in session cookie was missing or expired. The sign-in took longer than 10 minutes, '
            + 'or the redirect URI points to a different host than the one the sign-in started on (for example localhost vs 127.0.0.1).',
        })
      }
      return reply.redirect(OIDC_FAILED_REDIRECT)
    }
    try {
      const exchanged = await exchangeOidcCode(cfg, callbackUrlFor(cfg, query), flow)
      const decision = exchanged.denial ? { user: null, denial: exchanged.denial } as const : await evaluateOidcClaims(cfg, exchanged.claims)
      if (!decision.user) {
        const { denial } = decision
        req.log.warn({ code: denial.code, reason: denial.reason }, 'OIDC sign-in refused')
        await auditOidcDenial(cfg, denial)
        return reply.redirect(ACCOUNT_DENIALS.has(denial.code) ? '/admin/login?error=oidc_no_account' : OIDC_FAILED_REDIRECT)
      }
      const { user } = decision
      if (decision.link) await linkOidcIdentity(cfg, user, decision.subject)
      // The IdP authenticated the user and enforces its own MFA, so no local password or TOTP step.
      await createAuthSession(app, reply, { ...user, totpEnabled: 0 }, 'oidc')
      await writeAudit(
        { userId: user.id, userEmail: user.email },
        'update', 'user-security', user.id, user.email,
        { oidcLogin: true },
      )
      return reply.redirect('/admin/')
    } catch (error) {
      req.log.warn({ err: error }, 'OIDC callback failed')
      await auditOidcDenial(cfg, { code: 'token_exchange_failed', reason: `The sign-in could not be completed: ${errorText(error)}` })
      return reply.redirect(OIDC_FAILED_REDIRECT)
    }
  })

  app.post<{ Body: { email: string; password: string } }>('/login', {
    config: { rateLimit: LOGIN_RATE_LIMIT },
  }, async (req, reply) => {
    if (!passwordLoginEnabled((await getOidcConfig()).config)) return reply.code(403).send({ error: 'Password sign-in is disabled' })
    const { email, password } = req.body
    const user = (await db.select().from(users).where(eq(users.email, email)))[0]
    if (!user || !await verifyPassword(user, password)) {
      return reply.code(401).send({ error: 'Invalid credentials' })
    }
    if (user.totpEnabled) {
      const challengeToken = app.jwt.sign({ purpose: 'two-factor-login', userId: user.id }, { expiresIn: '5m' })
      return { requiresTwoFactor: true, challengeToken }
    }
    return finishLogin(app, reply, user)
  })

  app.post<{ Body: { challengeToken: string; code: string } }>('/2fa/verify', {
    config: { rateLimit: LOGIN_RATE_LIMIT },
  }, async (req, reply) => {
    let challenge: { purpose?: string; userId?: number }
    try { challenge = app.jwt.verify(req.body.challengeToken) }
    catch { return reply.code(401).send({ error: 'Two-factor challenge expired' }) }
    if (challenge.purpose !== 'two-factor-login' || !Number.isInteger(challenge.userId)) {
      return reply.code(401).send({ error: 'Invalid two-factor challenge' })
    }
    const user = (await db.select().from(users).where(eq(users.id, challenge.userId!)))[0]
    if (!user || !await verifySecondFactor(user, req.body.code)) {
      return reply.code(401).send({ error: 'Invalid authentication code' })
    }
    return finishLogin(app, reply, user)
  })

  app.get('/session', { preHandler: requireAuth, config: ALLOW_PENDING_PASSWORD_CHANGE }, async (req) => {
    return publicSession(requestIdentity(req))
  })

  app.post('/logout', { preHandler: requireAuth, config: ALLOW_PENDING_PASSWORD_CHANGE }, async (req, reply) => {
    const identity = requestIdentity(req)
    await revokeSession(identity.sessionId)
    clearAuthCookies(reply)
    return reply.code(204).send()
  })

  app.post('/logout-all', { preHandler: requireAuth, config: ALLOW_PENDING_PASSWORD_CHANGE }, async (req, reply) => {
    const identity = requestIdentity(req)
    await revokeUserSessions(identity.userId)
    clearAuthCookies(reply)
    return reply.code(204).send()
  })

  app.post<{ Body: { newPassword: string; currentPassword?: string } }>('/change-password', {
    preHandler: requireAuth,
    config: ALLOW_PENDING_PASSWORD_CHANGE,
  }, async (req, reply) => {
    const { newPassword, currentPassword } = req.body
    if (!newPassword || newPassword.length < 8 || newPassword.length > 128) {
      return reply.code(400).send({ error: 'Password must be between 8 and 128 characters' })
    }
    const identity = requestIdentity(req)
    const user = (await db.select().from(users).where(eq(users.id, identity.userId)))[0]
    if (!user) return reply.code(404).send({ error: 'User not found' })

    if (!user.mustChangePassword) {
      if (!currentPassword) return reply.code(400).send({ error: 'Current password is required' })
      if (!await verifyPassword(user, currentPassword)) {
        return reply.code(400).send({ error: 'Current password is incorrect' })
      }
    }

    const passwordHash = await bcrypt.hash(newPassword, 10)
    await db.update(users).set({ passwordHash, mustChangePassword: 0 }).where(eq(users.id, user.id))
    await writeAudit(
      { userId: identity.userId, userEmail: identity.email },
      'update', 'user-security', identity.userId, identity.email,
      { passwordChanged: true },
    )
    await revokeUserSessions(user.id)
    const updated = { ...user, passwordHash, mustChangePassword: 0 }
    // An SSO user setting a password stays in an SSO session.
    return finishLogin(app, reply, updated, identity.authMethod)
  })

  app.post<{ Body: { currentPassword: string } }>('/2fa/setup', { preHandler: requireAuth }, async (req, reply) => {
    const identity = requestIdentity(req)
    const user = (await db.select().from(users).where(eq(users.id, identity.userId)))[0]
    if (!user || !await verifyPassword(user, req.body.currentPassword)) {
      return reply.code(400).send({ error: 'Current password is incorrect' })
    }
    if (user.totpEnabled) return reply.code(409).send({ error: 'Two-factor authentication is already enabled' })
    const secret = generateTotpSecret()
    const uri = totpUri(secret, user.email)
    const setupToken = app.jwt.sign({
      purpose: 'two-factor-setup',
      userId: user.id,
      encryptedSecret: encrypt(secret),
    }, { expiresIn: '10m' })
    const qrDataUrl = await QRCode.toDataURL(uri, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 240,
      color: { dark: '#111827', light: '#ffffff' },
    })
    return { secret, uri, qrDataUrl, setupToken }
  })

  app.post<{ Body: { setupToken: string; code: string } }>('/2fa/enable', { preHandler: requireAuth }, async (req, reply) => {
    const identity = requestIdentity(req)
    let setup: { purpose?: string; userId?: number; encryptedSecret?: string }
    try { setup = app.jwt.verify(req.body.setupToken) }
    catch { return reply.code(400).send({ error: 'Two-factor setup expired' }) }
    if (setup.purpose !== 'two-factor-setup' || setup.userId !== identity.userId || !setup.encryptedSecret) {
      return reply.code(400).send({ error: 'Invalid two-factor setup' })
    }
    const secret = decrypt(setup.encryptedSecret)
    if (!verifyTotp(secret, req.body.code)) {
      return reply.code(400).send({ error: 'Invalid authentication code' })
    }
    const recoveryCodes = generateRecoveryCodes()
    await db.update(users).set({
      totpSecret: encrypt(secret),
      totpEnabled: 1,
      totpRecoveryCodes: JSON.stringify(recoveryCodes.map(hashRecoveryCode)),
    }).where(eq(users.id, identity.userId))
    await revokeUserSessions(identity.userId, identity.sessionId)
    await writeAudit(
      { userId: identity.userId, userEmail: identity.email },
      'update', 'user-security', identity.userId, identity.email,
      { twoFactorEnabled: { from: false, to: true } },
    )
    return { recoveryCodes }
  })

  app.post<{ Body: { currentPassword: string; code: string } }>('/2fa/disable', { preHandler: requireAuth }, async (req, reply) => {
    const identity = requestIdentity(req)
    const user = (await db.select().from(users).where(eq(users.id, identity.userId)))[0]
    if (!user || !await verifyPassword(user, req.body.currentPassword)) {
      return reply.code(400).send({ error: 'Current password is incorrect' })
    }
    if (!user.totpEnabled) return reply.code(409).send({ error: 'Two-factor authentication is not enabled' })
    if (!await verifySecondFactor(user, req.body.code)) {
      return reply.code(400).send({ error: 'Invalid authentication code' })
    }
    await db.update(users).set({ totpSecret: null, totpEnabled: 0, totpRecoveryCodes: null }).where(eq(users.id, user.id))
    await revokeUserSessions(user.id, identity.sessionId)
    await writeAudit(
      { userId: identity.userId, userEmail: identity.email },
      'update', 'user-security', identity.userId, identity.email,
      { twoFactorEnabled: { from: true, to: false } },
    )
    return { twoFactorEnabled: false }
  })
}
