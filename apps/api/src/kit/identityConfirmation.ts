import type { Auth } from '@better-kit/auth'
import { auth } from './auth.js'
export { SSO_CONFIRMATION_REQUIRED, SSO_CONFIRMATION_WINDOW_MS } from '@better-kit/auth'

// Forwards to the instance in ../kit/auth.ts; kept so call sites do not change.
type Group = Auth['identityConfirmation']
export const confirmIdentity: Group['confirmIdentity'] = (...args: Parameters<Group['confirmIdentity']>) => (auth.identityConfirmation.confirmIdentity as (...a: unknown[]) => unknown)(...args) as never
export const markSessionVerified: Group['markSessionVerified'] = (...args: Parameters<Group['markSessionVerified']>) => (auth.identityConfirmation.markSessionVerified as (...a: unknown[]) => unknown)(...args) as never
