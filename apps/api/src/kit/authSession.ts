import { auth } from './auth.js'
export { API_TOKEN_NOT_ACCEPTED } from '@better-kit/auth'
export type { AuthIdentity, AuthMethod } from '@better-kit/auth'

// The session functions of this application's auth instance (./auth.ts).
export const { createAuthSession, clearAuthCookies, authenticateRequest, verifyCsrf, revokeSession, revokeUserSessions } = auth.sessions
