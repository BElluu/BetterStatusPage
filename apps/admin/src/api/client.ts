export {
  ApiError, api, clearSession, enterAfterSignIn, getCurrentUser, isAuthenticated, mustChangePassword, setSession, type AuthUser,
} from '@better-forge/ui'
import type { AuthUser } from '@better-forge/ui'

/** A viewer may only view the status page; the admin console is closed to them. */
export function isViewer(user: AuthUser | null): boolean {
  return user?.role === 'viewer'
}
