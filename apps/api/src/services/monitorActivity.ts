import { and, inArray, ne } from 'drizzle-orm'
import { db } from '../db/client.js'
import { incidentMonitors, incidents, maintenanceWindowMonitors } from '../db/schema.js'
import { liveWindows, parseRecurrenceDays } from './maintenanceSchedule.js'
import { publishedIncident } from './incidentDetails.js'
import type { IncidentImpact, MaintenanceRecurrence, MonitorActivity } from '@bsp/shared'

const IMPACT_RANK: Record<IncidentImpact, number> = { minor: 1, major: 2, critical: 3 }

/**
 * What is going on around monitors right now: running and upcoming maintenance windows (an empty list of
 * monitors covers all of them) and open, published incidents. Drafts are not shown, as on the status page.
 */
export async function loadMonitorActivity(now = Date.now()): Promise<(monitorId: number) => MonitorActivity> {
  const windows = (await liveWindows(now)).sort((a, b) => Number(b.startsAt <= now) - Number(a.startsAt <= now) || a.startsAt - b.startsAt)
  const links = windows.length
    ? await db.select().from(maintenanceWindowMonitors).where(inArray(maintenanceWindowMonitors.windowId, windows.map((win) => win.id)))
    : []
  const covers = (win: (typeof windows)[number], monitorId: number) => {
    const own = links.filter((link) => link.windowId === win.id)
    return own.length === 0 || own.some((link) => link.monitorId === monitorId)
  }

  const open = await db.select({ id: incidents.id, impact: incidents.impact }).from(incidents)
    .where(and(ne(incidents.status, 'resolved'), publishedIncident))
  const incidentLinks = open.length
    ? await db.select().from(incidentMonitors).where(inArray(incidentMonitors.incidentId, open.map((incident) => incident.id)))
    : []
  const impactById = new Map(open.map((incident) => [incident.id, incident.impact as IncidentImpact]))
  const worst = new Map<number, IncidentImpact>()
  for (const link of incidentLinks) {
    const impact = impactById.get(link.incidentId)
    if (impact && (worst.get(link.monitorId) === undefined || IMPACT_RANK[impact] > IMPACT_RANK[worst.get(link.monitorId)!])) {
      worst.set(link.monitorId, impact)
    }
  }
  return (monitorId) => {
    const covering = windows.filter((win) => covers(win, monitorId))
    return {
      maintenance: covering.some((win) => win.startsAt <= now),
      windows: covering.map((win) => ({
        id: win.id, name: win.name, description: win.description, startsAt: win.startsAt, endsAt: win.endsAt,
        recurrence: win.recurrence as MaintenanceRecurrence, recurrenceDays: parseRecurrenceDays(win.recurrenceDays),
        timezone: win.timezone, recurrenceUntil: win.recurrenceUntil,
      })),
      incident: worst.get(monitorId) ?? null,
    }
  }
}
