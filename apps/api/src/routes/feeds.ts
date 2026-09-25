import type { FastifyInstance, FastifyRequest } from 'fastify'
import { desc, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { branding, incidentMonitors, incidentUpdates, incidents, maintenanceWindows } from '../db/schema.js'
import type { SubscriberEventType } from '@bsp/shared'
import { PUBLIC_FEED_RATE_LIMIT } from '../config/rateLimits.js'
import { feedMethodAvailable, getPublicComponents, getSubscriptionSettings } from '../services/subscriptions.js'
import { resolvePublicUrl } from '../config/publicUrl.js'

const FEED_SIZE = 50

function xml(value: string): string {
  return value
    // Characters XML 1.0 cannot carry at all, even escaped.
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

interface FeedEntry {
  id: number
  title: string
  status: string
  updatedAt: number
  startedAt: number
  summary: string
}

async function loadFeed(req: FastifyRequest) {
  const base = resolvePublicUrl() || `${req.protocol}://${req.host}`
  const site = (await db.select({ siteName: branding.siteName }).from(branding))[0]?.siteName || 'Status Page'

  const rows = await db.select().from(incidents).orderBy(desc(incidents.updatedAt)).limit(FEED_SIZE)
  const ids = rows.map((row) => row.id)
  const updates = ids.length
    ? await db.select().from(incidentUpdates).where(inArray(incidentUpdates.incidentId, ids)).orderBy(desc(incidentUpdates.postedAt))
    : []
  const links = ids.length ? await db.select().from(incidentMonitors).where(inArray(incidentMonitors.incidentId, ids)) : []
  const componentNames = new Map((await getPublicComponents()).map((component) => [component.id, component.name]))

  const entries: FeedEntry[] = rows.map((incident) => {
    const affected = links.filter((link) => link.incidentId === incident.id)
      .map((link) => componentNames.get(link.monitorId)).filter((name): name is string => !!name)
    const lines = [`Status: ${capitalize(incident.status)} · Impact: ${incident.impact}`]
    if (affected.length) lines.push(`Affected: ${affected.join(', ')}`)
    for (const update of updates.filter((u) => u.incidentId === incident.id)) {
      lines.push('', `${capitalize(update.status)} — ${new Date(update.postedAt).toISOString()}`, update.body)
    }
    return {
      id: incident.id,
      title: `${incident.title} — ${capitalize(incident.status)}`,
      status: incident.status,
      updatedAt: incident.updatedAt,
      startedAt: incident.startedAt,
      summary: lines.join('\n'),
    }
  })
  return { base, site, entries }
}

export async function feedRoutes(app: FastifyInstance) {
  await app.register(slackFeedRoutes)
  const feedRoute = { config: { rateLimit: PUBLIC_FEED_RATE_LIMIT } }

  app.get('/incidents.rss', feedRoute, async (req, reply) => {
    if (!feedMethodAvailable(await getSubscriptionSettings(), 'rss')) return reply.code(404).send({ error: 'Not found' })
    const { base, site, entries } = await loadFeed(req)
    const items = entries.map((entry) => `
    <item>
      <title>${xml(entry.title)}</title>
      <link>${xml(`${base}/`)}</link>
      <guid isPermaLink="false">${xml(`${base}/incidents/${entry.id}#${entry.updatedAt}`)}</guid>
      <pubDate>${new Date(entry.updatedAt).toUTCString()}</pubDate>
      <description>${xml(entry.summary)}</description>
    </item>`).join('')
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(`${site} — Incidents`)}</title>
    <link>${xml(`${base}/`)}</link>
    <description>${xml(`Incident history for ${site}`)}</description>
    <atom:link href="${xml(`${base}/api/v1/public/incidents.rss`)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${new Date(entries[0]?.updatedAt ?? Date.now()).toUTCString()}</lastBuildDate>${items}
  </channel>
</rss>
`
    return reply.header('Cache-Control', 'public, max-age=60').type('application/rss+xml; charset=utf-8').send(body)
  })

  app.get('/incidents.atom', feedRoute, async (req, reply) => {
    if (!feedMethodAvailable(await getSubscriptionSettings(), 'rss')) return reply.code(404).send({ error: 'Not found' })
    const { base, site, entries } = await loadFeed(req)
    const items = entries.map((entry) => `
  <entry>
    <id>${xml(`${base}/incidents/${entry.id}`)}</id>
    <title>${xml(entry.title)}</title>
    <link href="${xml(`${base}/`)}"/>
    <published>${new Date(entry.startedAt).toISOString()}</published>
    <updated>${new Date(entry.updatedAt).toISOString()}</updated>
    <content type="text">${xml(entry.summary)}</content>
  </entry>`).join('')
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${xml(`${base}/api/v1/public/incidents.atom`)}</id>
  <title>${xml(`${site} — Incidents`)}</title>
  <link href="${xml(`${base}/`)}"/>
  <link rel="self" href="${xml(`${base}/api/v1/public/incidents.atom`)}"/>
  <author><name>${xml(site)}</name></author>
  <updated>${new Date(entries[0]?.updatedAt ?? Date.now()).toISOString()}</updated>${items}
</feed>
`
    return reply.header('Cache-Control', 'public, max-age=60').type('application/atom+xml; charset=utf-8').send(body)
  })
}

interface SlackItem {
  guid: string
  title: string
  description: string
  at: number
}

/**
 * Slack's RSS app (`/feed subscribe <url>`) posts every new item to the channel, so this feed is
 * an event stream — one item per publication — rather than one item per incident that keeps
 * changing. Only the event types operators allow for subscribers appear in it.
 */
async function loadSlackFeed(req: FastifyRequest) {
  const settings = await getSubscriptionSettings()
  const base = resolvePublicUrl() || `${req.protocol}://${req.host}`
  const site = (await db.select({ siteName: branding.siteName }).from(branding))[0]?.siteName || 'Status Page'
  const allowed = new Set<SubscriberEventType>(settings.allowedEvents)
  const componentNames = new Map((await getPublicComponents()).map((component) => [component.id, component.name]))
  const items: SlackItem[] = []

  if (allowed.has('incident.created') || allowed.has('incident.updated') || allowed.has('incident.resolved')) {
    const rows = await db.select().from(incidents).orderBy(desc(incidents.updatedAt)).limit(FEED_SIZE)
    const ids = rows.map((row) => row.id)
    const updates = ids.length ? await db.select().from(incidentUpdates).where(inArray(incidentUpdates.incidentId, ids)) : []
    const links = ids.length ? await db.select().from(incidentMonitors).where(inArray(incidentMonitors.incidentId, ids)) : []
    for (const incident of rows) {
      const affected = links.filter((link) => link.incidentId === incident.id)
        .map((link) => componentNames.get(link.monitorId)).filter((name): name is string => !!name)
      const affectedLine = affected.length ? ` · Affected: ${affected.join(', ')}` : ''
      if (allowed.has('incident.created')) {
        items.push({
          guid: `incident-${incident.id}`,
          title: `New incident: ${incident.title}`,
          description: `Impact: ${incident.impact}${affectedLine}`,
          at: incident.createdAt,
        })
      }
      for (const update of updates.filter((u) => u.incidentId === incident.id)) {
        const resolved = update.status === 'resolved'
        if (!allowed.has(resolved ? 'incident.resolved' : 'incident.updated')) continue
        items.push({
          guid: `incident-update-${update.id}`,
          title: `${resolved ? 'Resolved' : capitalize(update.status)}: ${incident.title}`,
          description: `${update.body}\nImpact: ${incident.impact}${affectedLine}`,
          at: update.postedAt,
        })
      }
    }
  }

  if (allowed.has('maintenance.scheduled')) {
    const windows = await db.select().from(maintenanceWindows).orderBy(desc(maintenanceWindows.createdAt)).limit(FEED_SIZE)
    for (const win of windows) {
      const when = `${new Date(win.startsAt).toISOString().replace('T', ' ').slice(0, 16)} → ${new Date(win.endsAt).toISOString().replace('T', ' ').slice(0, 16)} UTC`
      items.push({
        guid: `maintenance-${win.id}`,
        title: `Scheduled maintenance: ${win.name}`,
        description: win.description ? `${when}\n${win.description}` : when,
        at: win.createdAt,
      })
    }
  }

  items.sort((a, b) => b.at - a.at)
  return { base, site, items: items.slice(0, FEED_SIZE) }
}

export async function slackFeedRoutes(app: FastifyInstance) {
  app.get('/slack.rss', { config: { rateLimit: PUBLIC_FEED_RATE_LIMIT } }, async (req, reply) => {
    if (!feedMethodAvailable(await getSubscriptionSettings(), 'slack')) return reply.code(404).send({ error: 'Not found' })
    const { base, site, items } = await loadSlackFeed(req)
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(`${site} status`)}</title>
    <link>${xml(`${base}/`)}</link>
    <description>${xml(`Status updates from ${site}`)}</description>
    <atom:link href="${xml(`${base}/api/v1/public/slack.rss`)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${new Date(items[0]?.at ?? Date.now()).toUTCString()}</lastBuildDate>${items.map((item) => `
    <item>
      <title>${xml(item.title)}</title>
      <link>${xml(`${base}/`)}</link>
      <guid isPermaLink="false">${xml(`${base}/${item.guid}`)}</guid>
      <pubDate>${new Date(item.at).toUTCString()}</pubDate>
      <description>${xml(item.description)}</description>
    </item>`).join('')}
  </channel>
</rss>
`
    return reply.header('Cache-Control', 'public, max-age=60').type('application/rss+xml; charset=utf-8').send(body)
  })
}
