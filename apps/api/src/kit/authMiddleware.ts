import type { Auth } from '@better-kit/auth'
import { auth } from './auth.js'
export { ALLOW_PENDING_PASSWORD_CHANGE, PASSWORD_CHANGE_REQUIRED, requestIdentity } from '@better-kit/auth'

// Forwards to the instance in ../kit/auth.ts; kept so call sites do not change.
type Group = Auth['middleware']
export const authenticateOrReject: Group['authenticateOrReject'] = (...args: Parameters<Group['authenticateOrReject']>) => (auth.middleware.authenticateOrReject as (...a: unknown[]) => unknown)(...args) as never
export const requireAuth: Group['requireAuth'] = Object.assign(
  (...args: Parameters<Group['requireAuth']>) => (auth.middleware.requireAuth as (...a: unknown[]) => unknown)(...args) as never,
  { requiresAuth: true as const },
)
export const requireRole: Group['requireRole'] = (...args: Parameters<Group['requireRole']>) => (auth.middleware.requireRole as (...a: unknown[]) => unknown)(...args) as never
