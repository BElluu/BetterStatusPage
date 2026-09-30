import { randomBytes } from 'node:crypto'
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
import { confirmIdentity, markSessionVerified } from '../services/identityConfirmation.js'
import { auditSignIn, auditSignInDenial, type CredentialDenialCode, type SignInMethod } from '../services/signInAudit.js'
import { passwordLoginEnabled, type OidcConfig } from '../config/oidc.js'
import { getOidcConfig, getOidcTestConfig } from '../services/oidcSettings.js'
import {
  auditOidcDenial,
  beginOidcLogin,
  evaluateOidcClaims,
  exchangeOidcCode,
  linkOidcIdentity,
  OIDC_CONFIRMATION_MAX_AGE_SECONDS,
  runOidcTest,
  storeOidcTestResult,
  type OidcDenialCode,
  type OidcFlowState,
} from '../services/oidc.js'

const OIDC_FLOW_COOKIE = 'bsp_oidc_flow'
const OIDC_FLOW_PATH = '/api/v1/auth/oidc'
const OIDC_FLOW_SECONDS = 10 * 60
const OIDC_FAILED_REDIRECT = '/admin/login?error=oidc_failed'
const SSO_CONFIRM_PAGE = '/admin/sso-confirm'
// Carries the pending second factor of an SSO sign-in from the callback to the login page's code form.
const TWO_FACTOR_CHALLENGE_COOKIE = 'bsp_2fa_challenge'
const TWO_FACTOR_CHALLENGE_PATH = '/api/v1/auth/2fa'
const TWO_FACTOR_CHALLENGE_SECONDS = 5 * 60
// Denials about the identity itself show "no account matches"; the rest show the generic failure.
const ACCOUNT_DENIALS = new Set<OidcDenialCode>(['no_email_claim', 'email_not_verified', 'no_matching_account', 'subject_mismatch'])
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000)

interface OidcFlowClaims extends OidcFlowState {
  /**
   * 'oidc-flow' signs a user in; 'oidc-test' only reports the outcome to the administrator who started it;
   * 'oidc-confirm' re-authenticates the user of an existing SSO session before a sensitive action.
   */
  purpose?: 'oidc-flow' | 'oidc-test' | 'oidc-confirm'
  adminUserId?: number
  /** 'oidc-confirm': the session to mark as confirmed and its user. The callback has no session cookie (SameSite=Strict). */
  sessionId?: string
  userId?: number
}

interface TwoFactorChallenge {
  purpose?: string
  userId?: number
  authMethod?: AuthMethod
}

/** Redirects to the provider, keeping the PKCE verifier, state and nonce in a short-lived signed cookie. */
export async function startOidcFlow(
  app: FastifyInstance, reply: FastifyReply, cfg: OidcConfig,
  extra: Pick<OidcFlowClaims, 'purpose' | 'adminUserId' | 'sessionId' | 'userId'>,
) {
  const { url, flow } = await beginOidcLogin(cfg, { confirm: extra.purpose === 'oidc-confirm' })
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

/** Records a refused password sign-in, or a refused 2FA step of either kind of sign-in. */
function denySignIn(method: SignInMethod, code: CredentialDenialCode, reason: string, email?: string) {
  return auditSignInDenial(method, { code, reason, email })
}

/**
 * Makes a pending temporary password unusable once its user signed in through SSO: they did not need it, and the
 * administrator who handed it out still knows it. They can set a password of their own later in Settings.
 */
async function revokeTemporaryPassword(user: typeof users.$inferSelect): Promise<typeof users.$inferSelect> {
  if (!user.mustChangePassword) return user
  const passwordHash = await bcrypt.hash(randomBytes(32).toString('base64url'), 10)
  await db.update(users).set({ passwordHash, mustChangePassword: 0 }).where(eq(users.id, user.id))
  await writeAudit({ userId: user.id, userEmail: user.email }, 'update', 'user-security', user.id, user.email, { temporaryPasswordRevoked: true })
  return { ...user, passwordHash, mustChangePassword: 0 }
}

/** Ends the SSO confirmation popup; the page tells the opening window through a BroadcastChannel. */
function confirmRedirect(reply: FastifyReply, ok: boolean) {
  return reply.redirect(`${SSO_CONFIRM_PAGE}?status=${ok ? 'ok' : 'failed'}`)
}

async function finishLogin(app: FastifyInstance, reply: FastifyReply, user: typeof users.$inferSelect, authMethod: AuthMethod = 'password') {
  const identity = await createAuthSession(app, reply, user, authMethod)
  return publicSession(identity)
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/config', async () => {
    const { config } = await getOidcConfig()
    // `loginUrl` starts SSO on the redirect URI's host: the flow cookie is only sent back to the host that set it,
    // so starting on another one (127.0.0.1 vs localhost, an internal name vs PUBLIC_URL) would lose it.
    return {
      passwordLogin: passwordLoginEnabled(config),
      oidc: config ? { label: config.buttonLabel, loginUrl: `${new URL(config.redirectUri).origin}${OIDC_FLOW_PATH}/login` } : null,
    }
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

  // Opened in a popup by the admin UI when a sensitive action needs an SSO session to be confirmed.
  app.get('/oidc/confirm', { preHandler: requireAuth, config: { rateLimit: LOGIN_RATE_LIMIT } }, async (req, reply) => {
    const identity = requestIdentity(req)
    const { config: cfg } = await getOidcConfig()
    if (identity.authMethod !== 'oidc' || !cfg) return confirmRedirect(reply, false)
    try {
      return await startOidcFlow(app, reply, cfg, { purpose: 'oidc-confirm', sessionId: identity.sessionId, userId: identity.userId })
    } catch (error) {
      req.log.error({ err: error }, 'OIDC discovery failed')
      await auditOidcDenial(cfg, { code: 'discovery_failed', reason: `OIDC discovery against the issuer failed: ${errorText(error)}` })
      return confirmRedirect(reply, false)
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

    if (flow?.purpose === 'oidc-confirm') {
      if (!flow.sessionId || !Number.isInteger(flow.userId)) return confirmRedirect(reply, false)
      try {
        const exchanged = await exchangeOidcCode(cfg, callbackUrlFor(cfg, query), flow, OIDC_CONFIRMATION_MAX_AGE_SECONDS)
        const decision = exchanged.denial ? { user: null, denial: exchanged.denial } as const : await evaluateOidcClaims(cfg, exchanged.claims)
        if (!decision.user || decision.user.id !== flow.userId) {
          const denial = decision.denial ?? {
            code: 'confirmation_mismatch' as const,
            reason: `The confirmation signed in as ${decision.user!.email}, not as the user of the session being confirmed.`,
            email: decision.user!.email,
          }
          req.log.warn({ code: denial.code, reason: denial.reason }, 'OIDC confirmation refused')
          await auditOidcDenial(cfg, denial)
          return confirmRedirect(reply, false)
        }
        if (decision.link) await linkOidcIdentity(cfg, decision.user, decision.subject)
        return confirmRedirect(reply, await markSessionVerified(flow.sessionId, flow.userId!))
      } catch (error) {
        req.log.warn({ err: error }, 'OIDC confirmation failed')
        await auditOidcDenial(cfg, { code: 'token_exchange_failed', reason: `The confirmation could not be completed: ${errorText(error)}` })
        return confirmRedirect(reply, false)
      }
    }

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
      // The IdP replaces the password. A user who enabled 2FA here still has to enter their code.
      if (user.totpEnabled) {
        const challenge: TwoFactorChallenge = { purpose: 'two-factor-login', userId: user.id, authMethod: 'oidc' }
        reply.setCookie(TWO_FACTOR_CHALLENGE_COOKIE, app.jwt.sign(challenge, { expiresIn: TWO_FACTOR_CHALLENGE_SECONDS }), {
          path: TWO_FACTOR_CHALLENGE_PATH,
          httpOnly: true,
          secure: process.env['NODE_ENV'] === 'production',
          sameSite: 'strict',
          maxAge: TWO_FACTOR_CHALLENGE_SECONDS,
        })
        return reply.redirect('/admin/login?two-factor=sso')
      }
      await createAuthSession(app, reply, await revokeTemporaryPassword(user), 'oidc')
      await auditSignIn(user, 'sso', false)
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
    const { email, password } = req.body
    const typedEmail = typeof email === 'string' && email.trim() ? email.trim().slice(0, 320) : undefined
    if (!passwordLoginEnabled((await getOidcConfig()).config)) {
      await denySignIn('password', 'password_login_disabled', 'Password sign-in is disabled; only single sign-on is allowed.', typedEmail)
      return reply.code(403).send({ error: 'Password sign-in is disabled' })
    }
    const user = (await db.select().from(users).where(eq(users.email, email)))[0]
    if (!user) {
      await denySignIn('password', 'no_matching_account', `No user has the email ${typedEmail ?? '(none entered)'}.`, typedEmail)
      return reply.code(401).send({ error: 'Invalid credentials' })
    }
    if (!await verifyPassword(user, password)) {
      await denySignIn('password', 'wrong_password', 'The password is incorrect.', user.email)
      return reply.code(401).send({ error: 'Invalid credentials' })
    }
    if (user.totpEnabled) {
      const challengeToken = app.jwt.sign({ purpose: 'two-factor-login', userId: user.id }, { expiresIn: '5m' })
      return { requiresTwoFactor: true, challengeToken }
    }
    const session = await finishLogin(app, reply, user)
    await auditSignIn(user, 'password', false)
    return session
  })

  // A password sign-in sends its challenge in the body; an SSO sign-in left it in a cookie at the callback.
  app.post<{ Body: { challengeToken?: string; code: string } }>('/2fa/verify', {
    config: { rateLimit: LOGIN_RATE_LIMIT },
  }, async (req, reply) => {
    const token = req.body.challengeToken || req.cookies[TWO_FACTOR_CHALLENGE_COOKIE]
    // Where the challenge came from says which sign-in it continues, even when it can no longer be read.
    const method: SignInMethod = req.body.challengeToken ? 'password' : 'sso'
    let challenge: TwoFactorChallenge
    try { challenge = app.jwt.verify(token ?? '') }
    catch {
      await denySignIn(method, 'two_factor_expired', 'The authentication code was entered more than 5 minutes after the first sign-in step, or the challenge was missing or invalid.')
      return reply.code(401).send({ error: 'Two-factor challenge expired' })
    }
    if (challenge.purpose !== 'two-factor-login' || !Number.isInteger(challenge.userId)) {
      return reply.code(401).send({ error: 'Invalid two-factor challenge' })
    }
    const found = (await db.select().from(users).where(eq(users.id, challenge.userId!)))[0]
    if (!found || !await verifySecondFactor(found, req.body.code)) {
      if (found) await denySignIn(method, 'invalid_two_factor_code', 'The authentication or recovery code is incorrect.', found.email)
      return reply.code(401).send({ error: 'Invalid authentication code' })
    }
    reply.clearCookie(TWO_FACTOR_CHALLENGE_COOKIE, { path: TWO_FACTOR_CHALLENGE_PATH })
    const authMethod: AuthMethod = challenge.authMethod === 'oidc' ? 'oidc' : 'password'
    const user = authMethod === 'oidc' ? await revokeTemporaryPassword(found) : found
    const session = await finishLogin(app, reply, user, authMethod)
    await auditSignIn(user, authMethod === 'oidc' ? 'sso' : 'password', true)
    return session
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

    // The session, not the user row: an SSO session never has to replace a temporary password, so it confirms too.
    if (!identity.mustChangePassword) {
      if (identity.authMethod === 'password' && !currentPassword) return reply.code(400).send({ error: 'Current password is required' })
      if (!await confirmIdentity(identity, currentPassword, reply)) return reply
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

  app.post<{ Body: { currentPassword?: string } }>('/2fa/setup', { preHandler: requireAuth }, async (req, reply) => {
    const identity = requestIdentity(req)
    if (!await confirmIdentity(identity, req.body?.currentPassword, reply)) return reply
    const user = (await db.select().from(users).where(eq(users.id, identity.userId)))[0]
    if (!user) return reply.code(404).send({ error: 'User not found' })
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

  app.post<{ Body: { currentPassword?: string; code: string } }>('/2fa/disable', { preHandler: requireAuth }, async (req, reply) => {
    const identity = requestIdentity(req)
    if (!await confirmIdentity(identity, req.body?.currentPassword, reply)) return reply
    const user = (await db.select().from(users).where(eq(users.id, identity.userId)))[0]
    if (!user) return reply.code(404).send({ error: 'User not found' })
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
