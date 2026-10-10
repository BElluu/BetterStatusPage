import type { FastifyReply, FastifyRequest } from 'fastify'
import { API_TOKEN_NOT_ACCEPTED, authenticateRequest, verifyCsrf, type AuthIdentity } from '../services/authSession.js'
import { consumeApiTokenBudget } from '../services/apiTokens.js'

declare module 'fastify' {
  interface FastifyContextConfig {
    allowPendingPasswordChange?: boolean
    /** Routes that accept an API token. Everything else answers 403 to one, so tokens never reach account security. */
    allowApiToken?: boolean
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

/**
 * Authenticates the request and checks its CSRF token. Answers 401 (with `unauthorized` as the body) or 403
 * itself and returns null when either fails, or when the user still has to replace a temporary password.
 * A hook that gets null must return the reply.
 */
export async function authenticateOrReject(
  req: FastifyRequest,
  reply: FastifyReply,
  unauthorized: Record<string, string> = { error: 'Unauthorized' },
): Promise<AuthIdentity | null> {
  const allowApiToken = req.routeOptions.config?.allowApiToken === true
  const existing = existingIdentity(req)
  let identity: AuthIdentity
  try {
    identity = existing ?? await authenticateRequest(req, { allowApiToken })
    if (identity.apiToken && !allowApiToken) throw new Error(API_TOKEN_NOT_ACCEPTED)
    await verifyCsrf(req, identity)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message === 'Invalid CSRF token') reply.code(403).send({ error: 'Invalid CSRF token' })
    else if (message === API_TOKEN_NOT_ACCEPTED) reply.code(403).send({ error: 'API tokens cannot call this endpoint' })
    else reply.code(401).send(unauthorized)
    return null
  }
  // Only a request that just authenticated spends budget; the later hooks of the same request reuse the identity.
  if (identity.apiToken && !existing && !consumeApiTokenBudget(identity.apiToken.id)) {
    reply.code(429).header('retry-after', '60').send({ error: 'Too many requests' })
    return null
  }
  if (passwordChangeBlocks(req, identity)) {
    sendPasswordChangeRequired(reply)
    return null
  }
  return identity
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!await authenticateOrReject(req, reply)) return reply
}

export function requireRole(...allowed: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await authenticateOrReject(req, reply)
    if (!identity) return reply
    const { role } = identity
    if (role !== 'admin' && !allowed.includes(role)) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
  }
}
