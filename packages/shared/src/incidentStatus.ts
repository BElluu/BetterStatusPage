import type { Incident, IncidentImpact } from './types/incident.js'
import type { MonitorStatus } from './types/monitor.js'

const STATUS_SEVERITY: Record<MonitorStatus, number> = {
  pending: 0,
  up: 0,
  affected: 1,
  degraded: 2,
  down: 3,
}

const IMPACT_SEVERITY: Record<IncidentImpact, number> = { minor: 1, major: 2, critical: 3 }

/** Status an open incident of this impact puts a monitor in: minor degrades it, major and critical take it down. */
export function incidentImpactStatus(impact: IncidentImpact): MonitorStatus {
  return impact === 'minor' ? 'degraded' : 'down'
}

/** The check result with an open incident laid over it; an incident never hides a more severe check result. */
export function withIncidentImpact(status: MonitorStatus, impact: IncidentImpact | null | undefined): MonitorStatus {
  if (!impact) return status
  const overlay = incidentImpactStatus(impact)
  return STATUS_SEVERITY[overlay] > STATUS_SEVERITY[status] ? overlay : status
}

/** The worst impact among the open incidents that name the monitor, or null when there is none. */
export function openIncidentImpact(monitorId: number, incidents: Incident[]): IncidentImpact | null {
  let worst: IncidentImpact | null = null
  for (const incident of incidents) {
    if (incident.status === 'resolved' || !incident.monitorIds?.includes(monitorId)) continue
    if (!worst || IMPACT_SEVERITY[incident.impact] > IMPACT_SEVERITY[worst]) worst = incident.impact
  }
  return worst
}

/** The status visitors see: the check result with the monitor's open incidents applied. */
export function applyIncidentStatus(status: MonitorStatus, monitorId: number, incidents: Incident[]): MonitorStatus {
  return withIncidentImpact(status, openIncidentImpact(monitorId, incidents))
}
