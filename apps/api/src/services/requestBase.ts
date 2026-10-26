import type { FastifyReply, FastifyRequest } from 'fastify'
import { resolvePublicUrl } from '../kit/runtime.js'

/**
 * The origin that links in a public response point at. Without PUBLIC_URL it comes from the request,
 * so the response varies by those headers and a shared cache must key on them: otherwise one request
 * with a forged host (reachable behind TRUST_PROXY through X-Forwarded-Host) fills the cache with
 * links to another domain.
 */
export function requestBase(req: FastifyRequest, reply: FastifyReply): string {
  const configured = resolvePublicUrl()
  if (configured) return configured
  reply.header('Vary', 'Host, X-Forwarded-Host, X-Forwarded-Proto')
  return `${req.protocol}://${req.host}`
}
