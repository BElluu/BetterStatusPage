import type { FastifyReply, FastifyRequest } from 'fastify'
import { authenticateRequest, verifyCsrf, type AuthIdentity } from '../services/authSession.js'

declare module 'fastify' {
  interface FastifyContextConfig {
    allowPendingPasswordChange?: boolean
  }
}

export const PASSWORD_CHANGE_REQUIRED = 'PASSWORD_CHANGE_REQUIRED'

/**
 * Route config for the few routes a user with a pending forced password change may still call
 * (session lookup, change-password, logout). Every other authenticated route answers 403 until
 * the password is changed, so the requirement is enforced server-side, not only by the admin UI.
 */
export const ALLOW_PENDING_PASSWORD_CHANGE = { allowPendingPasswordChange: true } as const

function existingIdentity(req: FastifyRequest): AuthIdentity | null {
  const value = req.user as Partial<AuthIdentity> | undefined
  return value?.sessionId && typeof value.userId === 'number' ? value as AuthIdentity : null
}

/**
 * The identity attached by requireAuth/requireRole. Only call from handlers behind one of them.
 */
export function requestIdentity(req: FastifyRequest): AuthIdentity {
  const value = req.user as Partial<AuthIdentity> | undefined
  if (typeof value?.userId !== 'number') throw new Error('requestIdentity called on an unauthenticated request')
  return value as AuthIdentity
}

function passwordChangeBlocks(req: FastifyRequest, identity: AuthIdentity): boolean {
  if (!identity.mustChangePassword) return false
  return req.routeOptions.config?.allowPendingPasswordChange !== true
}

function sendPasswordChangeRequired(reply: FastifyReply) {
  return reply.code(403).send({ error: 'Password change required', code: PASSWORD_CHANGE_REQUIRED })
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  let identity: AuthIdentity
  try {
    identity = existingIdentity(req) ?? await authenticateRequest(req)
    await verifyCsrf(req, identity)
  } catch (error) {
    const csrf = error instanceof Error && error.message === 'Invalid CSRF token'
    return reply.code(csrf ? 403 : 401).send({ error: csrf ? 'Invalid CSRF token' : 'Unauthorized' })
  }
  if (passwordChangeBlocks(req, identity)) return sendPasswordChangeRequired(reply)
}

export function requireRole(...allowed: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    let identity: AuthIdentity
    try {
      identity = existingIdentity(req) ?? await authenticateRequest(req)
      await verifyCsrf(req, identity)
    } catch (error) {
      const csrf = error instanceof Error && error.message === 'Invalid CSRF token'
      return reply.code(csrf ? 403 : 401).send({ error: csrf ? 'Invalid CSRF token' : 'Unauthorized' })
    }
    if (passwordChangeBlocks(req, identity)) return sendPasswordChangeRequired(reply)
    const { role } = identity
    if (role !== 'admin' && !allowed.includes(role)) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
  }
}
