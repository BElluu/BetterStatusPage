import type { Auth } from '@better-kit/auth'
import { auth } from '../kit/auth.js'
export { DEFAULT_OIDC_BUTTON_LABEL, DEFAULT_OIDC_SCOPES, isHttpUrl, passwordLoginEnabled } from '@better-kit/auth'
export type { OidcConfig, OidcSettingsInput } from '@better-kit/auth'

// Forwards to the instance in ../kit/auth.ts; kept so call sites do not change.
type Group = Auth['oidcConfig']
export const buildOidcConfig: Group['buildOidcConfig'] = (...args: Parameters<Group['buildOidcConfig']>) => (auth.oidcConfig.buildOidcConfig as (...a: unknown[]) => unknown)(...args) as never
export const defaultOidcRedirectUri: Group['defaultOidcRedirectUri'] = (...args: Parameters<Group['defaultOidcRedirectUri']>) => (auth.oidcConfig.defaultOidcRedirectUri as (...a: unknown[]) => unknown)(...args) as never
export const resolveOidcConfigFromEnv: Group['resolveOidcConfigFromEnv'] = (...args: Parameters<Group['resolveOidcConfigFromEnv']>) => (auth.oidcConfig.resolveOidcConfigFromEnv as (...a: unknown[]) => unknown)(...args) as never

