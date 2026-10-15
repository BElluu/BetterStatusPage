export const DEFAULT_OIDC_SCOPES = 'openid email profile'
export const DEFAULT_OIDC_BUTTON_LABEL = 'Sign in with SSO'

export interface OidcConfig {
  issuer: string
  clientId: string
  clientSecret: string
  scopes: string
  redirectUri: string
  buttonLabel: string
  allowUnverifiedEmail: boolean
  disablePasswordLogin: boolean
}

/** Raw, unvalidated OIDC settings from either source (environment or the database). */
export interface OidcSettingsInput {
  issuer?: string | undefined
  clientId?: string | undefined
  clientSecret?: string | undefined
  scopes?: string | undefined
  redirectUri?: string | undefined
  buttonLabel?: string | undefined
  allowUnverifiedEmail?: boolean | undefined
  disablePasswordLogin?: boolean | undefined
}

function flag(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase())
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Settings validation and the environment variables, for an application whose public address is `publicUrl(env)` and
 * whose provider redirects back to `callbackPath`.
 */
export function createOidcConfigResolver(options: { publicUrl: (env: NodeJS.ProcessEnv) => string; callbackPath: string }) {
  /** Callback URL derived from the public URL, or '' when that is not set. */
  function defaultOidcRedirectUri(env: NodeJS.ProcessEnv = process.env): string {
    const publicUrl = options.publicUrl(env)
    return publicUrl ? `${publicUrl}${options.callbackPath}` : ''
  }

  /** Validates raw settings and fills defaults. Returns null when they do not describe a usable setup. */
  function buildOidcConfig(input: OidcSettingsInput, env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
    const issuer = (input.issuer ?? '').trim()
    const clientId = (input.clientId ?? '').trim()
    if (!issuer || !clientId || !isHttpUrl(issuer)) return null
    const redirectUri = (input.redirectUri ?? '').trim() || defaultOidcRedirectUri(env)
    if (!redirectUri || !isHttpUrl(redirectUri)) return null
    return {
      issuer,
      clientId,
      clientSecret: (input.clientSecret ?? '').trim(),
      scopes: (input.scopes ?? '').trim() || DEFAULT_OIDC_SCOPES,
      redirectUri,
      buttonLabel: (input.buttonLabel ?? '').trim() || DEFAULT_OIDC_BUTTON_LABEL,
      allowUnverifiedEmail: input.allowUnverifiedEmail === true,
      disablePasswordLogin: input.disablePasswordLogin === true,
    }
  }

  /**
   * OIDC settings from environment variables, which override anything saved in the admin UI
   * (for IaC deployments). Returns null when OIDC_ISSUER / OIDC_CLIENT_ID are not both set.
   */
  function resolveOidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
    if (!(env['OIDC_ISSUER'] ?? '').trim() || !(env['OIDC_CLIENT_ID'] ?? '').trim()) return null
    const config = buildOidcConfig({
      issuer: env['OIDC_ISSUER'],
      clientId: env['OIDC_CLIENT_ID'],
      clientSecret: env['OIDC_CLIENT_SECRET'],
      scopes: env['OIDC_SCOPES'],
      redirectUri: env['OIDC_REDIRECT_URI'],
      buttonLabel: env['OIDC_BUTTON_LABEL'],
      allowUnverifiedEmail: flag(env['OIDC_ALLOW_UNVERIFIED_EMAIL']),
      disablePasswordLogin: flag(env['OIDC_DISABLE_PASSWORD_LOGIN']),
    }, env)
    if (!config) console.warn('OIDC_* environment variables are set but incomplete or invalid (issuer, client id and a redirect URI or PUBLIC_URL are required) — OIDC sign-in is disabled')
    return config
  }

  return { defaultOidcRedirectUri, buildOidcConfig, resolveOidcConfigFromEnv }
}

/** Password sign-in can only be turned off while OIDC is usable, so nobody is locked out by a typo. */
export function passwordLoginEnabled(config: OidcConfig | null): boolean {
  return !(config && config.disablePasswordLogin)
}
