import * as client from 'openid-client'
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import type { OidcConfig } from '../config/oidc.js'

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

/** Completes the code exchange and returns the local user matching the verified email, or null. */
export async function completeOidcLogin(cfg: OidcConfig, callbackUrl: URL, flow: OidcFlowState) {
  const config = await discover(cfg)
  const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: flow.codeVerifier,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
    idTokenExpected: true,
  })
  const claims = tokens.claims()
  const email = typeof claims?.['email'] === 'string' ? claims['email'].trim().toLowerCase() : ''
  if (!email) return null
  const verified = claims?.['email_verified']
  if (verified !== true && !(cfg.allowUnverifiedEmail && verified === undefined)) return null
  return (await db.select().from(users).where(sql`lower(${users.email}) = ${email}`))[0] ?? null
}

/** Runs OIDC discovery against the issuer without caching, to validate settings before saving them. */
export async function testOidcDiscovery(cfg: OidcConfig): Promise<{ issuer: string; authorizationEndpoint: string | null }> {
  const config = await client.discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret || undefined)
  const meta = config.serverMetadata()
  return { issuer: meta.issuer, authorizationEndpoint: meta.authorization_endpoint ?? null }
}
