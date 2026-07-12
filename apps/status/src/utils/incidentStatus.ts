import type { Incident, MonitorStatus } from '@bsp/shared'

const STATUS_SEVERITY: Record<MonitorStatus, number> = {
  pending: 0,
  up: 0,
  affected: 1,
  degraded: 2,
  down: 3,
}

export function applyIncidentStatus(
  currentStatus: MonitorStatus,
  monitorId: number,
  incidents: Incident[],
): MonitorStatus {
  let incidentStatus: MonitorStatus | null = null

  for (const incident of incidents) {
    if (incident.status === 'resolved' || !incident.monitorIds?.includes(monitorId)) continue
    const candidate = incident.impact === 'minor'
      ? 'degraded'
      : incident.impact === 'major' || incident.impact === 'critical'
        ? 'down'
        : null
    if (candidate && (!incidentStatus || STATUS_SEVERITY[candidate] > STATUS_SEVERITY[incidentStatus])) {
      incidentStatus = candidate
    }
  }

  return incidentStatus && STATUS_SEVERITY[incidentStatus] > STATUS_SEVERITY[currentStatus]
    ? incidentStatus
    : currentStatus
}
