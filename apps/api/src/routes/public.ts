import type { FastifyInstance } from 'fastify'
import { serveEventStream, sseService } from '../kit/sse.js'
import { chartRangeKey, getPublishedChartRanges, getPublishedMonitorIds, publishedMonitorIdsSnapshot } from '../services/publishedMonitors.js'
import { createTtlCache } from '../lib/ttlCache.js'
import { PUBLIC_EVENTS_RATE_LIMIT, PUBLIC_HISTORY_RATE_LIMIT } from '../config/rateLimits.js'
import {
  loadPublicStatus, loadPublicLayout, loadPublicIncidents, loadPublicIncident, loadUptime, loadHistory, publishIncident,
} from '../services/publicStatusData.js'
import { parseStrictPagination } from '../lib/pagination.js'
import { authenticateRequest, type AuthIdentity } from '../kit/authSession.js'
import { isStatusPagePrivate } from '../services/statusPageAccess.js'
import { protectStatusPage } from '../services/statusPageGate.js'

const STATUS_CACHE_TTL_MS = 2_000
/** Daily uptime bars change slowly; a short cache absorbs bursts of page views per monitor. */
const UPTIME_CACHE_TTL_MS = 30_000
const UPTIME_CACHE_MAX_ENTRIES = 1_000
/** The response time charts slide with the clock, but a bucket is minutes wide: a few seconds old is not visible. */
const HISTORY_CACHE_TTL_MS = 10_000
const HISTORY_CACHE_MAX_ENTRIES = 1_000

function parseInteger(value: string | undefined, fallback: number, min: number, max: number): number | null {
  const parsed = Number(value ?? fallback)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null
}

export async function publicRoutes(app: FastifyInstance) {
  protectStatusPage(app)
  let statusCache: { expiresAt: number; value: Promise<unknown> } | null = null
  // Keyed by `${monitorId}:${days}`.
  const uptimeCache = createTtlCache<unknown>(UPTIME_CACHE_TTL_MS, UPTIME_CACHE_MAX_ENTRIES)
  // Keyed by `${monitorId}:${hours}:${buckets}`; it holds no incidents, so incident events leave it alone.
  const historyCache = createTtlCache<unknown>(HISTORY_CACHE_TTL_MS, HISTORY_CACHE_MAX_ENTRIES)
  // Clients refetch the status as soon as an incident event arrives; a cached copy from just
  // before the change would hide it from them until the next periodic refresh.
  const stopListening = sseService.onBroadcast((event) => {
    if (event.startsWith('incident.')) {
      statusCache = null
      // Uptime bars list the incidents of each day.
      uptimeCache.clear()
    }
  })
  app.addHook('onClose', async () => { stopListening() })

  app.get('/status', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=2, stale-while-revalidate=5')
    const now = Date.now()
    if (statusCache && statusCache.expiresAt > now) return statusCache.value

    const value = loadPublicStatus()
    statusCache = { expiresAt: now + STATUS_CACHE_TTL_MS, value }
    value.catch(() => {
      if (statusCache?.value === value) statusCache = null
    })
    return value
  })

  app.get('/layout', async () => loadPublicLayout())

  app.get<{ Querystring: { page?: string; limit?: string } }>('/incidents', async (req, reply) => {
    const paging = parseStrictPagination(req.query, { defaultLimit: 10, maxLimit: 100 })
    if (paging === null) {
      return reply.code(400).send({ error: 'page must be a positive integer and limit must be between 1 and 100' })
    }

    return loadPublicIncidents(paging)
  })

  app.get<{ Params: { id: string } }>('/incidents/:id', async (req, reply) => {
    const incidentId = parseInteger(req.params.id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (incidentId === null) return reply.code(400).send({ error: 'Invalid incident id' })
    const incident = await loadPublicIncident(incidentId)
    if (!incident) return reply.code(404).send({ error: 'Not found' })
    return incident
  })

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>('/monitor/:id/uptime', {
    config: { rateLimit: PUBLIC_HISTORY_RATE_LIMIT },
  }, async (req, reply) => {
    const days = parseInteger(req.query.days, 90, 1, 90)
    const monitorId = parseInteger(req.params.id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (days === null || monitorId === null) {
      return reply.code(400).send({ error: 'Invalid monitor id or days; days must be between 1 and 90' })
    }
    if (!(await getPublishedMonitorIds()).has(monitorId)) return reply.code(404).send({ error: 'Not found' })

    return uptimeCache.get(`${monitorId}:${days}`, () => loadUptime(monitorId, days))
  })

  app.get<{ Params: { id: string }; Querystring: { hours?: string; buckets?: string } }>(
    '/monitor/:id/history',
    { config: { rateLimit: PUBLIC_HISTORY_RATE_LIMIT } },
    async (req, reply) => {
      const monitorId = parseInteger(req.params.id, 0, 1, Number.MAX_SAFE_INTEGER)
      const hours = parseInteger(req.query.hours, 24, 1, 2160)
      const nBuckets = parseInteger(req.query.buckets, 30, 10, 100)
      if (monitorId === null || hours === null || nBuckets === null) {
        return reply.code(400).send({ error: 'Invalid monitor id, hours, or buckets' })
      }

      // Only the ranges the charts of the page ask for: any other one is a fresh scan of up to 90 days.
      if (!(await getPublishedChartRanges()).has(chartRangeKey(monitorId, hours, nBuckets))) return reply.code(404).send({ error: 'Not found' })

      return historyCache.get(`${monitorId}:${hours}:${nBuckets}`, () => loadHistory(monitorId, hours, nBuckets))
    },
  )

  // Visitors only hear about published monitors; the admin panel has its own authenticated stream.
  // On a private page the stream belongs to a session: signing out ends it, and the keep-alive re-checks access.
  app.get('/events', { config: { rateLimit: PUBLIC_EVENTS_RATE_LIMIT } }, async (req, reply) => {
    await getPublishedMonitorIds()
    const identity = req.user as AuthIdentity | undefined
    const session = identity?.sessionId ? { sessionId: identity.sessionId, userId: identity.userId } : undefined
    await serveEventStream(req, reply, {
      filter: publicEventFilter,
      session,
      stillAllowed: async () => !await isStatusPagePrivate() || (!!session && !!await authenticateRequest(req)),
    })
  })
}

/**
 * Status changes of internal monitors are not sent at all, and incident events lose their links to
 * internal monitors (including the one that opened them). The status page only uses incident events as a cue to refetch.
 */
function publicEventFilter(event: string, data: unknown): { data: unknown } | null {
  const published = publishedMonitorIdsSnapshot()
  if (event === 'monitor.status') {
    return published.has((data as { monitorId: number }).monitorId) ? { data } : null
  }
  // Drafts exist for operators only.
  if (event.startsWith('incident.') && (data as { draft?: unknown } | null)?.draft === true) return null
  if (event.startsWith('incident.') && data && typeof data === 'object') return { data: publishIncident(data as { monitorIds?: number[]; autoMonitorId?: number | null }, published) }
  return { data }
}
