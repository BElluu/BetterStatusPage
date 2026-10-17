import { eq } from 'drizzle-orm'
import { oidcSettings } from './tables.js'
import type { AuthOptions } from './context.js'
import type { OidcConfig, createOidcConfigResolver } from './oidcConfig.js'

export type OidcSettingsRow = typeof oidcSettings.$inferSelect

export function createOidcSettings(ctx: AuthOptions, resolver: ReturnType<typeof createOidcConfigResolver>) {
  const { db, secretBox } = ctx
  const { buildOidcConfig, resolveOidcConfigFromEnv } = resolver

  async function getOidcSettingsRow(): Promise<OidcSettingsRow | null> {
    return (await db.select().from(oidcSettings).where(eq(oidcSettings.id, 1)))[0] ?? null
  }

  function oidcConfigFromRow(row: OidcSettingsRow): OidcConfig | null {
    return buildOidcConfig({
      issuer: row.issuer,
      clientId: row.clientId,
      clientSecret: row.clientSecret ? secretBox.decrypt(row.clientSecret) : '',
      scopes: row.scopes,
      redirectUri: row.redirectUri,
      buttonLabel: row.buttonLabel,
      allowUnverifiedEmail: !!row.allowUnverifiedEmail,
      disablePasswordLogin: !!row.disablePasswordLogin,
    })
  }

  /** OIDC_FORCE_PASSWORD_LOGIN=true is the break-glass switch when the IdP is down and password sign-in was disabled. */
  function withPasswordOverride(config: OidcConfig): OidcConfig {
    return ['1', 'true', 'yes'].includes((process.env['OIDC_FORCE_PASSWORD_LOGIN'] ?? '').trim().toLowerCase())
      ? { ...config, disablePasswordLogin: false }
      : config
  }

  /**
   * The OIDC configuration in effect: environment variables win (deployment-managed), otherwise the
   * settings saved in the admin UI when enabled. Read per request, so saving takes effect without a restart.
   */
  async function getOidcConfig(): Promise<{ config: OidcConfig | null; source: 'env' | 'database' | 'none' }> {
    const fromEnv = resolveOidcConfigFromEnv()
    if (fromEnv) return { config: withPasswordOverride(fromEnv), source: 'env' }
    const row = await getOidcSettingsRow()
    if (!row?.enabled) return { config: null, source: 'none' }
    const config = oidcConfigFromRow(row)
    return { config: config && withPasswordOverride(config), source: config ? 'database' : 'none' }
  }

  /** Settings a test sign-in runs against: the environment, or the saved settings even while SSO is switched off. */
  async function getOidcTestConfig(): Promise<OidcConfig | null> {
    const fromEnv = resolveOidcConfigFromEnv()
    if (fromEnv) return fromEnv
    const row = await getOidcSettingsRow()
    return row ? oidcConfigFromRow(row) : null
  }

  return { getOidcSettingsRow, oidcConfigFromRow, getOidcConfig, getOidcTestConfig }
}

export type OidcSettings = ReturnType<typeof createOidcSettings>
