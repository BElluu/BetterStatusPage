import { auth } from './auth.js'
export { API_TOKEN_NOT_ACCEPTED } from '@better-forge/auth'
export type { AuthIdentity, AuthMethod } from '@better-forge/auth'

// The session functions of this application's auth instance (./auth.ts).
export const { createAuthSession, clearAuthCookies, authenticateRequest, verifyCsrf, revokeSession, revokeUserSessions } = auth.sessions
