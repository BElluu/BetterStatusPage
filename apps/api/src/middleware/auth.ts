import type { FastifyReply, FastifyRequest } from 'fastify'

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  try { await req.jwtVerify() } catch { return reply.code(401).send({ error: 'Unauthorized' }) }
}

export function requireRole(...allowed: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify()
      const { role } = req.user as { role: string }
      if (role !== 'admin' && !allowed.includes(role)) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
  }
}
