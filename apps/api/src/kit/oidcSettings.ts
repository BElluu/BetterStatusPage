import type { Auth } from '@better-kit/auth'
import { auth } from './auth.js'
export type { OidcSettingsRow } from '@better-kit/auth'

// Forwards to the instance in ../kit/auth.ts; kept so call sites do not change.
type Group = Auth['oidcSettings']
export const getOidcSettingsRow: Group['getOidcSettingsRow'] = (...args: Parameters<Group['getOidcSettingsRow']>) => (auth.oidcSettings.getOidcSettingsRow as (...a: unknown[]) => unknown)(...args) as never
export const oidcConfigFromRow: Group['oidcConfigFromRow'] = (...args: Parameters<Group['oidcConfigFromRow']>) => (auth.oidcSettings.oidcConfigFromRow as (...a: unknown[]) => unknown)(...args) as never
export const getOidcConfig: Group['getOidcConfig'] = (...args: Parameters<Group['getOidcConfig']>) => (auth.oidcSettings.getOidcConfig as (...a: unknown[]) => unknown)(...args) as never
export const getOidcTestConfig: Group['getOidcTestConfig'] = (...args: Parameters<Group['getOidcTestConfig']>) => (auth.oidcSettings.getOidcTestConfig as (...a: unknown[]) => unknown)(...args) as never
