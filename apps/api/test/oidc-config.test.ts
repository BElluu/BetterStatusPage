import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildOidcConfig, passwordLoginEnabled, resolveOidcConfigFromEnv } from '../src/config/oidc.js'

const base = { OIDC_ISSUER: 'https://idp.example.test', OIDC_CLIENT_ID: 'bsp', PUBLIC_URL: 'https://status.example.test' }

describe('OIDC configuration from environment', () => {
  it('is disabled without issuer and client id', () => {
    assert.equal(resolveOidcConfigFromEnv({}), null)
    assert.equal(resolveOidcConfigFromEnv({ OIDC_ISSUER: base.OIDC_ISSUER }), null)
  })

  it('derives the redirect URI from PUBLIC_URL', () => {
    const cfg = resolveOidcConfigFromEnv(base)
    assert.equal(cfg?.redirectUri, 'https://status.example.test/api/v1/auth/oidc/callback')
    assert.equal(cfg?.scopes, 'openid email profile')
    assert.equal(cfg?.allowUnverifiedEmail, false)
  })

  it('prefers an explicit OIDC_REDIRECT_URI', () => {
    const cfg = resolveOidcConfigFromEnv({ ...base, OIDC_REDIRECT_URI: 'https://admin.example.test/cb' })
    assert.equal(cfg?.redirectUri, 'https://admin.example.test/cb')
  })

  it('is disabled when no redirect URI can be determined', () => {
    assert.equal(resolveOidcConfigFromEnv({ OIDC_ISSUER: base.OIDC_ISSUER, OIDC_CLIENT_ID: base.OIDC_CLIENT_ID }), null)
  })
})

describe('OIDC settings validation', () => {
  const input = { issuer: 'https://idp.example.test', clientId: 'bsp', redirectUri: 'https://status.example.test/cb' }

  it('fills defaults', () => {
    const cfg = buildOidcConfig(input, {})
    assert.equal(cfg?.buttonLabel, 'Sign in with SSO')
    assert.equal(cfg?.clientSecret, '')
    assert.equal(cfg?.disablePasswordLogin, false)
  })

  it('rejects non-http(s) URLs and missing fields', () => {
    assert.equal(buildOidcConfig({ ...input, issuer: 'javascript:alert(1)' }, {}), null)
    assert.equal(buildOidcConfig({ ...input, redirectUri: 'not a url' }, {}), null)
    assert.equal(buildOidcConfig({ ...input, clientId: ' ' }, {}), null)
  })

  it('disables password login only while OIDC is usable', () => {
    assert.equal(passwordLoginEnabled(null), true)
    assert.equal(passwordLoginEnabled(buildOidcConfig(input, {})), true)
    assert.equal(passwordLoginEnabled(buildOidcConfig({ ...input, disablePasswordLogin: true }, {})), false)
  })
})
