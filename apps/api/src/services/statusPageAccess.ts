import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { STATUS_PAGE_PRIVATE, type StatusPageAccessSettings } from '@bsp/shared'
import { db } from '../db/client.js'
import { statusPageAccess } from '../db/schema.js'
import { authenticateOrReject } from '../middleware/auth.js'
import { sseService } from './sse.service.js'

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/
const MAX_VIEWER_DOMAINS = 50

export class StatusPageAccessError extends Error {}

function parseDomains(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

export async function getStatusPageAccess(): Promise<StatusPageAccessSettings> {
  const row = (await db.select().from(statusPageAccess).where(eq(statusPageAccess.id, 1)))[0]
  return {
    private: !!row?.private,
    ssoCreateViewers: !!row?.ssoCreateViewers,
    ssoViewerDomains: row ? parseDomains(row.ssoViewerDomains) : [],
  }
}

export async function isStatusPagePrivate(): Promise<boolean> {
  return (await getStatusPageAccess()).private
}

/** Lowercases, drops a leading "@" and duplicates. Throws on anything that is not a domain name. */
export function normalizeViewerDomains(input: unknown): string[] {
  if (!Array.isArray(input)) throw new StatusPageAccessError('Email domains must be a list')
  const domains = new Set<string>()
  for (const value of input) {
    const domain = String(value ?? '').trim().toLowerCase().replace(/^@/, '')
    if (!domain) continue
    if (!DOMAIN_PATTERN.test(domain)) throw new StatusPageAccessError(`"${domain}" is not a valid email domain`)
    domains.add(domain)
  }
  if (domains.size > MAX_VIEWER_DOMAINS) throw new StatusPageAccessError(`At most ${MAX_VIEWER_DOMAINS} email domains are allowed`)
  return [...domains]
}

export async function saveStatusPageAccess(input: Partial<Record<keyof StatusPageAccessSettings, unknown>>): Promise<StatusPageAccessSettings> {
  const next: StatusPageAccessSettings = {
    private: input.private === true,
    ssoCreateViewers: input.ssoCreateViewers === true,
    ssoViewerDomains: normalizeViewerDomains(input.ssoViewerDomains ?? []),
  }
  // Without a domain list any account at a multi-tenant provider (Google, Microsoft personal accounts) would get in.
  if (next.ssoCreateViewers && next.ssoViewerDomains.length === 0) {
    throw new StatusPageAccessError('Add at least one email domain to create viewer accounts on SSO sign-in')
  }
  const row = {
    private: next.private ? 1 : 0,
    ssoCreateViewers: next.ssoCreateViewers ? 1 : 0,
    ssoViewerDomains: JSON.stringify(next.ssoViewerDomains),
    updatedAt: Date.now(),
  }
  await db.insert(statusPageAccess).values({ id: 1, ...row })
    .onConflictDoUpdate({ target: statusPageAccess.id, set: row })
  // Visitors who opened the live stream while the page was public must not keep receiving updates.
  if (next.private) sseService.disconnectAnonymous()
  return next
}

/** Whether an SSO sign-in with this verified email, which matches no account, may create a viewer account. */
export function viewerProvisioningAllowed(settings: StatusPageAccessSettings, email: string): boolean {
  if (!settings.private || !settings.ssoCreateViewers) return false
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
  return email.includes('@') && settings.ssoViewerDomains.includes(domain)
}

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
