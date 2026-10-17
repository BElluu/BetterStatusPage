import { auth } from './auth.js'
export { ALLOW_PENDING_PASSWORD_CHANGE, PASSWORD_CHANGE_REQUIRED, requestIdentity } from '@better-kit/auth'

// The sign-in guards of this application's auth instance (./auth.ts).
export const { authenticateOrReject, requireAuth, requireRole } = auth.middleware
