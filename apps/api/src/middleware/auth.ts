import type { FastifyReply, FastifyRequest } from 'fastify'
import { authenticateRequest, verifyCsrf, type AuthIdentity } from '../services/authSession.js'

function existingIdentity(req: FastifyRequest): AuthIdentity | null {
  const value = req.user as Partial<AuthIdentity> | undefined
  return value?.sessionId && typeof value.userId === 'number' ? value as AuthIdentity : null
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  try {
    const identity = existingIdentity(req) ?? await authenticateRequest(req)
    await verifyCsrf(req, identity)
  } catch (error) {
    const csrf = error instanceof Error && error.message === 'Invalid CSRF token'
    return reply.code(csrf ? 403 : 401).send({ error: csrf ? 'Invalid CSRF token' : 'Unauthorized' })
  }
}

export function requireRole(...allowed: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = existingIdentity(req) ?? await authenticateRequest(req)
      await verifyCsrf(req, identity)
      const { role } = identity
      if (role !== 'admin' && !allowed.includes(role)) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
    } catch (error) {
      const csrf = error instanceof Error && error.message === 'Invalid CSRF token'
      return reply.code(csrf ? 403 : 401).send({ error: csrf ? 'Invalid CSRF token' : 'Unauthorized' })
    }
  }
}
