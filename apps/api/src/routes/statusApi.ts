import type { FastifyInstance, FastifyReply } from 'fastify'
import { gte, inArray, ne } from 'drizzle-orm'
import { db } from '../db/client.js'
import { branding, incidentMonitors, incidents, layout, maintenanceWindowMonitors, maintenanceWindows, monitors } from '../db/schema.js'
import type {
  ApiActiveIncident, ApiActiveMaintenance, ApiComponent, ApiComponentRef, ApiComponentStatus, ApiComponents,
  ApiPageStatus, ApiSummary, LayoutNode, LayoutTree,
} from '@bsp/shared'
import { PUBLIC_API_RATE_LIMIT } from '../config/rateLimits.js'
import { feedMethodAvailable, getSubscriptionSettings } from '../services/subscriptions.js'
import { resolvePublicUrl } from '../config/publicUrl.js'

const SEVERITY: Record<Exclude<ApiComponentStatus, 'under_maintenance'>, number> = {
  operational: 0,
  degraded_performance: 1,
  partial_outage: 2,
  major_outage: 3,
}

type Issue = Exclude<ApiComponentStatus, 'under_maintenance'>
const worse = (a: Issue, b: Issue): Issue => (SEVERITY[b] > SEVERITY[a] ? b : a)

function monitorIssue(status: string): Issue {
  if (status === 'down') return 'major_outage'
  if (status === 'degraded' || status === 'affected') return 'degraded_performance'
  return 'operational'
}

/** Same rule as the status page: minor incidents degrade, major and critical ones take components down. */
function incidentIssue(impact: string): Issue {
  if (impact === 'minor') return 'degraded_performance'
  if (impact === 'major' || impact === 'critical') return 'major_outage'
  return 'operational'
}

function groupStatus(children: ApiComponentStatus[]): ApiComponentStatus {
  const issues = children.filter((status): status is Issue => status !== 'under_maintenance')
  if (children.length === 0) return 'operational'
  if (issues.length === 0) return 'under_maintenance'
  const downs = issues.filter((status) => status === 'major_outage').length
  if (downs > 0) return downs === children.length ? 'major_outage' : 'partial_outage'
  const worst = issues.reduce(worse, 'operational')
  if (worst !== 'operational') return worst
  return issues.length < children.length ? 'under_maintenance' : 'operational'
}

const iso = (ms: number) => new Date(ms).toISOString()

/**
 * Everything both endpoints need, computed once per request from the published layout so the API
 * reports exactly the components — and statuses — visitors see on the page.
 */
async function loadState(baseUrl: string) {
  const now = Date.now()
  const layoutRow = (await db.select().from(layout))[0]
  let tree: LayoutNode[]
  try { tree = layoutRow ? (JSON.parse(layoutRow.tree) as LayoutTree).children ?? [] : [] } catch { tree = [] }

  const monitorRows = await db.select({ id: monitors.id, name: monitors.name, currentStatus: monitors.currentStatus }).from(monitors)
  const monitorById = new Map(monitorRows.map((row) => [row.id, row]))

  const activeIncidents = await db.select().from(incidents).where(ne(incidents.status, 'resolved'))
  const incidentLinks = activeIncidents.length
    ? await db.select().from(incidentMonitors).where(inArray(incidentMonitors.incidentId, activeIncidents.map((i) => i.id)))
    : []

  const windows = await db.select().from(maintenanceWindows).where(gte(maintenanceWindows.endsAt, now))
  const windowLinks = windows.length
    ? await db.select().from(maintenanceWindowMonitors).where(inArray(maintenanceWindowMonitors.windowId, windows.map((w) => w.id)))
    : []
  const running = windows.filter((win) => win.startsAt <= now)
  const inMaintenance = (monitorId: number) => running.some((win) => {
    const links = windowLinks.filter((link) => link.windowId === win.id)
    return links.length === 0 || links.some((link) => link.monitorId === monitorId)
  })

  const componentStatus = (monitorId: number): ApiComponentStatus => {
    if (inMaintenance(monitorId)) return 'under_maintenance'
    let status = monitorIssue(monitorById.get(monitorId)?.currentStatus ?? 'pending')
    for (const incident of activeIncidents) {
      if (incidentLinks.some((link) => link.incidentId === incident.id && link.monitorId === monitorId)) {
        status = worse(status, incidentIssue(incident.impact))
      }
    }
    return status
  }

  const publicIds = new Set<number>()
  const build = (nodes: LayoutNode[]): ApiComponent[] => nodes.flatMap((node): ApiComponent[] => {
    if (node.type === 'monitor') {
      const monitor = monitorById.get(node.monitorId)
      if (!monitor || publicIds.has(monitor.id)) return []
      publicIds.add(monitor.id)
      return [{ id: monitor.id, name: monitor.name, status: componentStatus(monitor.id), description: null, isParent: false, children: [] }]
    }
    if (node.type === 'group') {
      const children = build(node.children)
      if (children.length === 0) return []
      return [{
        id: `group:${node.id}`, name: node.label, status: groupStatus(children.map((child) => child.status)),
        description: null, isParent: true, children,
      }]
    }
    return []
  })
  const components = build(tree)

  const refs = (ids: number[]): ApiComponentRef[] => ids
    .filter((id) => publicIds.has(id))
    .map((id) => ({ id, name: monitorById.get(id)!.name }))

  const url = `${baseUrl}/`
  const apiIncidents: ApiActiveIncident[] = activeIncidents
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((incident) => ({
      id: incident.id,
      name: incident.title,
      status: incident.status as ApiActiveIncident['status'],
      impact: incident.impact,
      startedAt: iso(incident.startedAt),
      updatedAt: iso(incident.updatedAt),
      url,
      components: refs(incidentLinks.filter((link) => link.incidentId === incident.id).map((link) => link.monitorId)),
    }))
  const apiMaintenances: ApiActiveMaintenance[] = windows
    .sort((a, b) => a.startsAt - b.startsAt)
    .map((win) => ({
      id: win.id,
      name: win.name,
      description: win.description,
      status: win.startsAt <= now ? 'in_progress' : 'not_started',
      startsAt: iso(win.startsAt),
      endsAt: iso(win.endsAt),
      duration: Math.round((win.endsAt - win.startsAt) / 60_000),
      url,
      components: refs(windowLinks.filter((link) => link.windowId === win.id).map((link) => link.monitorId)),
    }))

  const flat = (list: ApiComponent[]): ApiComponent[] => list.flatMap((c) => (c.isParent ? flat(c.children) : [c]))
  const leafStatuses = flat(components).map((component) => component.status)
  const pageStatus: ApiPageStatus = apiIncidents.length > 0 || leafStatuses.some((s) => s !== 'operational' && s !== 'under_maintenance')
    ? 'has_issues'
    : running.length > 0 ? 'under_maintenance' : 'operational'

  return { components, apiIncidents, apiMaintenances, pageStatus, url }
}

function apiHeaders(reply: FastifyReply): FastifyReply {
  // Meant to be polled by other sites' dashboards and scripts, including from the browser.
  return reply.header('Access-Control-Allow-Origin', '*').header('Cache-Control', 'public, max-age=30')
}

export async function statusApiRoutes(app: FastifyInstance) {
  const route = { config: { rateLimit: PUBLIC_API_RATE_LIMIT } }

  async function baseUrl(req: { protocol: string; host: string }) {
    return resolvePublicUrl() || `${req.protocol}://${req.host}`
  }

  app.get('/summary.json', route, async (req, reply): Promise<ApiSummary | void> => {
    if (!feedMethodAvailable(await getSubscriptionSettings(), 'api')) return reply.code(404).send({ error: 'Not found' })
    const state = await loadState(await baseUrl(req))
    const name = (await db.select({ siteName: branding.siteName }).from(branding))[0]?.siteName || 'Status Page'
    apiHeaders(reply)
    return {
      page: { name, url: state.url, status: state.pageStatus },
      activeIncidents: state.apiIncidents,
      activeMaintenances: state.apiMaintenances,
    }
  })

  app.get('/components.json', route, async (req, reply): Promise<ApiComponents | void> => {
    if (!feedMethodAvailable(await getSubscriptionSettings(), 'api')) return reply.code(404).send({ error: 'Not found' })
    const state = await loadState(await baseUrl(req))
    apiHeaders(reply)
    return { components: state.components }
  })
}

