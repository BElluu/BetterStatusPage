import * as client from 'openid-client'
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import type { OidcConfig } from '../config/oidc.js'
import { writeAudit } from './audit.js'

let cached: { key: string; config: Promise<client.Configuration> } | null = null

function discover(cfg: OidcConfig): Promise<client.Configuration> {
  const key = `${cfg.issuer}|${cfg.clientId}|${cfg.clientSecret}`
  if (cached?.key !== key) {
    const config = client.discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret || undefined)
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

export async function beginOidcLogin(cfg: OidcConfig): Promise<{ url: string; flow: OidcFlowState }> {
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

export interface OidcDenial {
  code: OidcDenialCode
  reason: string
  email?: string
}

export type OidcLoginResult =
  | { user: typeof users.$inferSelect; denial?: undefined }
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

/** Completes the code exchange and returns the local user matching the verified email, or why there is none. */
export async function completeOidcLogin(cfg: OidcConfig, callbackUrl: URL, flow: OidcFlowState): Promise<OidcLoginResult> {
  const config = await discover(cfg)
  let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>
  try {
    tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    })
  } catch (error) {
    return { user: null, denial: describeExchangeError(error) }
  }
  const claims: Record<string, unknown> = tokens.claims() ?? {}
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
  return user
    ? { user }
    : { user: null, denial: { code: 'no_matching_account', reason: `No user has the email ${email}. Create the user first.`, email } }
}

/**
 * Records a refused SSO sign-in. Nobody is signed in yet, so the actor is user 0 with the email the
 * provider asserted, when there was one.
 */
export async function auditOidcDenial(cfg: OidcConfig, denial: OidcDenial): Promise<void> {
  await writeAudit(
    { userId: 0, userEmail: denial.email ?? 'unknown (SSO)' },
    'deny', 'oidc_login', null, denial.email ?? 'SSO sign-in',
    { code: denial.code, reason: denial.reason, issuer: cfg.issuer },
  )
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
  const config = await client.discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret || undefined)
  const meta = config.serverMetadata()
  return { issuer: meta.issuer, authorizationEndpoint: meta.authorization_endpoint ?? null }
}
