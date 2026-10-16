import type { Auth } from '@better-kit/auth'
import { auth } from './auth.js'
export { checkEmailVerified, OIDC_CONFIRMATION_MAX_AGE_SECONDS } from '@better-kit/auth'
export type { OidcDecision, OidcDenial, OidcDenialCode, OidcFlowState, OidcTestResult, SsoProvisioning } from '@better-kit/auth'

// Forwards to the instance in ../kit/auth.ts; kept so call sites do not change.
type Group = Auth['oidc']
export const readOidcTestResult: Group['readOidcTestResult'] = (...args: Parameters<Group['readOidcTestResult']>) => (auth.oidc.readOidcTestResult as (...a: unknown[]) => unknown)(...args) as never
export const storeOidcTestResult: Group['storeOidcTestResult'] = (...args: Parameters<Group['storeOidcTestResult']>) => (auth.oidc.storeOidcTestResult as (...a: unknown[]) => unknown)(...args) as never
export const testOidcDiscovery: Group['testOidcDiscovery'] = (...args: Parameters<Group['testOidcDiscovery']>) => (auth.oidc.testOidcDiscovery as (...a: unknown[]) => unknown)(...args) as never
