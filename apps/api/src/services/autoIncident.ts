import { and, eq, gte, ne } from 'drizzle-orm'
import { db } from '../db/client.js'
import { incidentMonitors, incidents, incidentTemplates, incidentUpdates, monitors } from '../db/schema.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { sseService } from './sse.service.js'
import { withIncidentDetails } from './incidentDetails.js'
import { notifyIncidentSubscribers } from '../workers/subscriberNotifier.js'
import { getPublishedMonitorIds } from './publishedMonitors.js'

const MAX_TITLE = 200

type MonitorRow = typeof monitors.$inferSelect
type TemplateRow = typeof incidentTemplates.$inferSelect

export const TEMPLATE_VARIABLES = ['monitor', 'duration', 'status', 'error'] as const

/** Replaces `{{name}}` placeholders; unknown placeholders stay visible so a typo is easy to spot. */
export function renderTemplate(text: string, vars: Partial<Record<typeof TEMPLATE_VARIABLES[number], string>>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => vars[name as keyof typeof vars] ?? match)
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

async function templateFor(monitor: MonitorRow): Promise<TemplateRow | undefined> {
  if (monitor.autoIncidentTemplateId !== null) {
    const chosen = (await db.select().from(incidentTemplates).where(eq(incidentTemplates.id, monitor.autoIncidentTemplateId)))[0]
    if (chosen) return chosen
  }
  return (await db.select().from(incidentTemplates).where(eq(incidentTemplates.isDefault, 1)))[0]
}

async function openAutoIncident(monitorId: number): Promise<typeof incidents.$inferSelect | undefined> {
  return (await db.select().from(incidents)
    .where(and(eq(incidents.autoMonitorId, monitorId), ne(incidents.status, 'resolved'))))[0]
}

/**
 * Opens an incident once a confirmed outage has lasted the monitor's configured time.
 * One open automatic incident per monitor; calling again while it is open does nothing.
 */
export async function openIncidentForOutage(monitor: MonitorRow, error: string | null, now = Date.now()): Promise<void> {
  if (monitor.autoIncidentMinutes === null || monitor.failingSince === null) return
  const lasted = now - monitor.failingSince
  if (lasted < monitor.autoIncidentMinutes * 60_000) return

  const template = await templateFor(monitor)
  if (!template) return
  // A monitor that is not on the public page never gets a public incident: its name would be the only thing visitors learn about it.
  const draft = monitor.autoIncidentMode !== 'published' || !(await getPublishedMonitorIds()).has(monitor.id)
  // Check errors can hold hostnames or credentials; only an operator-reviewed draft may show them.
  const vars = { monitor: monitor.name, duration: formatDuration(lasted), status: 'down', error: draft ? (error ?? '') : '' }

  // The check and the insert share a transaction so overlapping checks cannot open two. An incident the
  // operator already resolved by hand for this same outage is not reopened by the next check.
  const created = await withImmediateTransaction(async () => {
    const existing = await db.select({ id: incidents.id }).from(incidents)
      .where(and(eq(incidents.autoMonitorId, monitor.id), gte(incidents.startedAt, monitor.failingSince!)))
    if (existing.length > 0) return undefined
    const incident = (await db.insert(incidents).values({
      title: renderTemplate(template.title, vars).slice(0, MAX_TITLE),
      status: 'investigating',
      impact: template.impact,
      startedAt: monitor.failingSince!,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
      draft: draft ? 1 : 0,
      autoMonitorId: monitor.id,
    }).returning())[0]!
    await db.insert(incidentMonitors).values({ incidentId: incident.id, monitorId: monitor.id })
    await db.insert(incidentUpdates).values({
      incidentId: incident.id, body: renderTemplate(template.body, vars), status: 'investigating', postedAt: now,
    })
    return incident
  })
  if (!created) return

  const [enriched] = await withIncidentDetails([created])
  sseService.broadcast('incident.created', enriched)
  if (!draft) await notifyIncidentSubscribers('incident.created', created.id).catch((err) =>
    console.error('[auto-incident] Failed to queue incident notice:', err))
}

/** Closes the monitor's open automatic incident after recovery. Drafts are resolved too, but never announced. */
export async function resolveIncidentForRecovery(monitor: MonitorRow, now = Date.now()): Promise<void> {
  const incident = await openAutoIncident(monitor.id)
  if (!incident) return

  const template = await templateFor(monitor)
  const vars = { monitor: monitor.name, duration: formatDuration(now - incident.startedAt), status: 'up', error: '' }
  const body = renderTemplate(template?.resolvedBody ?? '{{monitor}} is available again.', vars)

  // Re-checked inside the transaction: two overlapping recoveries must resolve the incident once.
  const update = await withImmediateTransaction(async () => {
    const stillOpen = (await db.select({ id: incidents.id }).from(incidents)
      .where(and(eq(incidents.id, incident.id), ne(incidents.status, 'resolved')))).length > 0
    if (!stillOpen) return undefined
    const posted = (await db.insert(incidentUpdates).values({
      incidentId: incident.id, body, status: 'resolved', postedAt: now,
    }).returning())[0]!
    await db.update(incidents).set({ status: 'resolved', resolvedAt: now, updatedAt: now }).where(eq(incidents.id, incident.id))
    return posted
  })
  if (!update) return

  const resolved = (await db.select().from(incidents).where(eq(incidents.id, incident.id)))[0]!
  const [enriched] = await withIncidentDetails([resolved])
  sseService.broadcast('incident.updated', enriched)
  if (!resolved.draft) {
    await notifyIncidentSubscribers('incident.resolved', incident.id, { body: update.body, status: update.status, postedAt: update.postedAt })
      .catch((err) => console.error('[auto-incident] Failed to queue incident notice:', err))
  }
}
