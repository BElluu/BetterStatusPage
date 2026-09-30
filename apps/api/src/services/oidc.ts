import { randomUUID } from 'node:crypto'
import * as client from 'openid-client'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import type { OidcConfig } from '../config/oidc.js'
import { writeAudit } from './audit.js'
import { auditSignInDenial } from './signInAudit.js'

type User = typeof users.$inferSelect

let cached: { key: string; config: Promise<client.Configuration> } | null = null

function runDiscovery(cfg: OidcConfig): Promise<client.Configuration> {
  const issuer = new URL(cfg.issuer)
  // The client library refuses plain http; allow it only for issuers configured that way (e.g. a local Keycloak).
  const options = issuer.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : undefined
  return client.discovery(issuer, cfg.clientId, cfg.clientSecret || undefined, undefined, options)
}

function discover(cfg: OidcConfig): Promise<client.Configuration> {
  const key = `${cfg.issuer}|${cfg.clientId}|${cfg.clientSecret}`
  if (cached?.key !== key) {
    const config = runDiscovery(cfg)
    config.catch(() => { if (cached?.key === key) cached = null })
    cached = { key, config }
  }
  return cached.config
}

export interface OidcFlowState {
  state: string
  nonce: string
  codeVerifier: string
}

/** An SSO confirmation must come from a sign-in at the provider no older than this (the ID token's auth_time). */
export const OIDC_CONFIRMATION_MAX_AGE_SECONDS = 5 * 60

/**
 * Builds the provider redirect. `confirm` asks the provider to authenticate the user again (`prompt=login`)
 * and to report when it did (`max_age`), so the callback can require a fresh `auth_time`.
 */
export async function beginOidcLogin(cfg: OidcConfig, options: { confirm?: boolean } = {}): Promise<{ url: string; flow: OidcFlowState }> {
  const config = await discover(cfg)
  const flow: OidcFlowState = {
    state: client.randomState(),
    nonce: client.randomNonce(),
    codeVerifier: client.randomPKCECodeVerifier(),
  }
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes,
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: await client.calculatePKCECodeChallenge(flow.codeVerifier),
    code_challenge_method: 'S256',
    ...(options.confirm ? { prompt: 'login', max_age: String(OIDC_CONFIRMATION_MAX_AGE_SECONDS) } : {}),
  })
  return { url: url.href, flow }
}

/** Why an SSO sign-in was refused. The user only sees a generic message; the audit log gets the code and detail. */
export type OidcDenialCode =
  | 'discovery_failed'
  | 'flow_expired'
  | 'idp_error'
  | 'token_exchange_failed'
  | 'no_email_claim'
  | 'email_not_verified'
  | 'no_matching_account'
  | 'subject_mismatch'
  | 'confirmation_mismatch'

export interface OidcDenial {
  code: OidcDenialCode
  reason: string
  email?: string
}

/**
 * The outcome for a set of validated ID token claims. `link` means the user was matched by email and the
 * identity (issuer + subject) should now be bound to them, so later sign-ins no longer depend on the email.
 */
export type OidcDecision =
  | { user: User; link: boolean; subject: string; denial?: undefined }
  | { user: null; denial: OidcDenial }

// Some providers send booleans as strings ("true").
const isTrue = (value: unknown) => value === true || value === 'true'
const isFalse = (value: unknown) => value === false || value === 'false'

/**
 * Whether the email claim may be trusted. `email_verified` is the standard claim; Microsoft Entra ID never
 * sends it but offers the optional `xms_edov` claim (email domain owner verified) instead. An explicit
 * `false` from either claim is never overridden by `allowUnverifiedEmail`.
 */
export function checkEmailVerified(claims: Record<string, unknown>, allowUnverifiedEmail: boolean): string | null {
  const standard = claims['email_verified']
  const entra = claims['xms_edov']
  if (isTrue(standard) || isTrue(entra)) return null
  if (isFalse(standard)) return 'The identity provider reports the email as unverified (email_verified is false).'
  if (isFalse(entra)) return 'Microsoft Entra ID reports that the email domain is not verified (xms_edov is false).'
  if (allowUnverifiedEmail && standard === undefined && entra === undefined) return null
  return 'The ID token has neither an email_verified nor an xms_edov claim. For Microsoft Entra ID, add the xms_edov optional claim to the ID token. '
    + 'For other providers, enable "Accept identity providers that omit email_verified" only if their email claim is trustworthy.'
}

/**
 * Completes the code exchange and returns the validated ID token claims, or why that failed. With `maxAge`
 * the ID token must carry an `auth_time` no older than that many seconds.
 */
export async function exchangeOidcCode(
  cfg: OidcConfig, callbackUrl: URL, flow: OidcFlowState, maxAge?: number,
): Promise<{ claims: Record<string, unknown>; denial?: undefined } | { claims?: undefined; denial: OidcDenial }> {
  const config = await discover(cfg)
  try {
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
      ...(maxAge !== undefined ? { maxAge } : {}),
    })
    return { claims: tokens.claims() ?? {} }
  } catch (error) {
    return { denial: describeExchangeError(error) }
  }
}

/**
 * Finds the local user for validated claims without changing anything. An identity already bound to a
 * user wins; otherwise the verified email is matched, but never onto a user bound to another identity at
 * the same provider, so an email address given to someone else cannot take over the account.
 */
export async function evaluateOidcClaims(cfg: OidcConfig, claims: Record<string, unknown>): Promise<OidcDecision> {
  const subject = typeof claims['sub'] === 'string' ? claims['sub'] : ''
  if (subject) {
    const bound = (await db.select().from(users)
      .where(and(eq(users.oidcIssuer, cfg.issuer), eq(users.oidcSubject, subject))))[0]
    if (bound) return { user: bound, link: false, subject }
  }

  const email = typeof claims['email'] === 'string' ? claims['email'].trim().toLowerCase() : ''
  if (!email) {
    return {
      user: null,
      denial: {
        code: 'no_email_claim',
        reason: `The ID token has no email claim. Request the "email" scope and, for Microsoft Entra ID, add the email optional claim. Claims received: ${Object.keys(claims).join(', ') || 'none'}.`,
      },
    }
  }
  const unverified = checkEmailVerified(claims, cfg.allowUnverifiedEmail)
  if (unverified) return { user: null, denial: { code: 'email_not_verified', reason: unverified, email } }
  const user = (await db.select().from(users).where(sql`lower(${users.email}) = ${email}`))[0]
  if (!user) {
    return { user: null, denial: { code: 'no_matching_account', reason: `No user has the email ${email}. Create the user first.`, email } }
  }
  if (user.oidcSubject && user.oidcIssuer === cfg.issuer) {
    return {
      user: null,
      denial: {
        code: 'subject_mismatch',
        reason: `${user.email} is linked to another identity at this provider (subject ${user.oidcSubject}; this sign-in: ${subject || 'none'}). `
          + 'The email address may have been given to someone else.',
        email,
      },
    }
  }
  return { user, link: true, subject }
}

/** Binds the provider identity to the user and records it; a binding to a previous issuer is replaced. */
export async function linkOidcIdentity(cfg: OidcConfig, user: User, subject: string): Promise<void> {
  await db.update(users).set({ oidcIssuer: cfg.issuer, oidcSubject: subject }).where(eq(users.id, user.id))
  await writeAudit(
    { userId: user.id, userEmail: user.email },
    'update', 'user-security', user.id, user.email,
    { ssoLinked: { from: user.oidcIssuer, to: cfg.issuer }, subject },
  )
}

/** Records a refused SSO sign-in or confirmation as a 'sign_in' denial, with the issuer. */
export async function auditOidcDenial(cfg: OidcConfig, denial: OidcDenial): Promise<void> {
  await auditSignInDenial('sso', denial, { issuer: cfg.issuer })
}

function describeExchangeError(error: unknown): OidcDenial {
  if (error instanceof client.AuthorizationResponseError) {
    const description = error.error_description ? `: ${error.error_description}` : ''
    return { code: 'idp_error', reason: `The identity provider returned ${error.error}${description}`.slice(0, 1000) }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'token_exchange_failed', reason: `Code exchange or ID token validation failed: ${message}`.slice(0, 1000) }
}

/** Runs OIDC discovery against the issuer without caching, to validate settings before saving them. */
export async function testOidcDiscovery(cfg: OidcConfig): Promise<{ issuer: string; authorizationEndpoint: string | null }> {
  const config = await runDiscovery(cfg)
  const meta = config.serverMetadata()
  return { issuer: meta.issuer, authorizationEndpoint: meta.authorization_endpoint ?? null }
}

// ── Test sign-in ────────────────────────────────────────────────────────────
// An administrator runs the real flow to see the claims and what would happen, without signing anyone in.

export interface OidcTestResult {
  issuer: string
  testedAt: number
  claims: Record<string, unknown> | null
  outcome: 'sign_in' | 'link' | 'deny'
  user: string | null
  denial: OidcDenial | null
}

const TEST_RESULT_TTL_MS = 10 * 60 * 1000
const testResults = new Map<string, { adminUserId: number; expiresAt: number; result: OidcTestResult }>()

export function storeOidcTestResult(adminUserId: number, result: OidcTestResult): string {
  const now = Date.now()
  for (const [id, entry] of testResults) if (entry.expiresAt <= now) testResults.delete(id)
  const id = randomUUID()
  testResults.set(id, { adminUserId, expiresAt: now + TEST_RESULT_TTL_MS, result })
  return id
}

/** Only the administrator who started the test can read its result. */
export function readOidcTestResult(id: string, adminUserId: number): OidcTestResult | null {
  const entry = testResults.get(id)
  if (!entry || entry.expiresAt <= Date.now() || entry.adminUserId !== adminUserId) return null
  return entry.result
}

export async function runOidcTest(cfg: OidcConfig, callbackUrl: URL, flow: OidcFlowState): Promise<OidcTestResult> {
  const base = { issuer: cfg.issuer, testedAt: Date.now() }
  const exchanged = await exchangeOidcCode(cfg, callbackUrl, flow)
    .catch((error: unknown) => ({ claims: undefined, denial: describeExchangeError(error) }))
  if (exchanged.denial) return { ...base, claims: null, outcome: 'deny', user: null, denial: exchanged.denial }
  const decision = await evaluateOidcClaims(cfg, exchanged.claims)
  if (decision.denial) return { ...base, claims: exchanged.claims, outcome: 'deny', user: null, denial: decision.denial }
  return { ...base, claims: exchanged.claims, outcome: decision.link ? 'link' : 'sign_in', user: decision.user.email, denial: null }
}
