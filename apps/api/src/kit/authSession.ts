import type { Auth } from '@better-kit/auth'
import { auth } from './auth.js'
export { API_TOKEN_NOT_ACCEPTED } from '@better-kit/auth'
export type { AuthIdentity, AuthMethod } from '@better-kit/auth'

// Forwards to the instance in ../kit/auth.ts; kept so call sites do not change.
type Group = Auth['sessions']
export const createAuthSession: Group['createAuthSession'] = (...args: Parameters<Group['createAuthSession']>) => (auth.sessions.createAuthSession as (...a: unknown[]) => unknown)(...args) as never
export const clearAuthCookies: Group['clearAuthCookies'] = (...args: Parameters<Group['clearAuthCookies']>) => (auth.sessions.clearAuthCookies as (...a: unknown[]) => unknown)(...args) as never
export const authenticateRequest: Group['authenticateRequest'] = (...args: Parameters<Group['authenticateRequest']>) => (auth.sessions.authenticateRequest as (...a: unknown[]) => unknown)(...args) as never
export const verifyCsrf: Group['verifyCsrf'] = (...args: Parameters<Group['verifyCsrf']>) => (auth.sessions.verifyCsrf as (...a: unknown[]) => unknown)(...args) as never
export const revokeSession: Group['revokeSession'] = (...args: Parameters<Group['revokeSession']>) => (auth.sessions.revokeSession as (...a: unknown[]) => unknown)(...args) as never
export const revokeUserSessions: Group['revokeUserSessions'] = (...args: Parameters<Group['revokeUserSessions']>) => (auth.sessions.revokeUserSessions as (...a: unknown[]) => unknown)(...args) as never
