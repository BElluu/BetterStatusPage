import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { STATUS_PAGE_PRIVATE } from '@bsp/shared'
import { authenticateOrReject } from '../kit/authMiddleware.js'
import { isStatusPagePrivate } from './statusPageAccess.js'

// Kept apart from statusPageAccess.ts: kit/auth.ts reads the access settings from there while it creates the auth
// instance, so that file must not import the sign-in guard, which comes from that instance.
const privateResponses = new WeakSet<FastifyRequest>()

/**
 * Puts the routes of `app` (and its child plugins) behind a sign-in while the status page is private.
 * Any signed-in user may view the page; their responses must not be kept by shared caches or indexed.
 */
export function protectStatusPage(app: FastifyInstance): void {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!await isStatusPagePrivate()) return
    privateResponses.add(req)
    const identity = await authenticateOrReject(req, reply, { error: 'Sign in to view this status page', code: STATUS_PAGE_PRIVATE })
    if (!identity) return reply
  })
  app.addHook('onSend', async (req, reply, payload) => {
    if (!privateResponses.has(req)) return payload
    reply.header('X-Robots-Tag', 'noindex, nofollow')
    const cacheControl = reply.getHeader('cache-control')
    if (typeof cacheControl === 'string') reply.header('Cache-Control', cacheControl.replace(/\bpublic\b/, 'private'))
    return payload
  })
}
