import { withIncidentImpact } from '@bsp/shared'
import type { IncidentImpact, MonitorActivity, MonitorStatus, MonitorWithActivity } from '@bsp/shared'

const configs: Record<MonitorStatus, { label: string; color: string; bg: string }> = {
  up:       { label: 'Operational',      color: 'var(--m3-up)',       bg: 'var(--m3-up-bg)' },
  down:     { label: 'Down',            color: 'var(--m3-down)',     bg: 'var(--m3-down-bg)' },
  degraded: { label: 'Degraded',        color: 'var(--m3-degraded)', bg: 'var(--m3-degraded-bg)' },
  pending:  { label: 'Pending',         color: 'var(--m3-secondary)', bg: 'var(--m3-surface-container)' },
  affected: { label: 'Dep. Issue',      color: 'var(--m3-degraded)', bg: 'var(--m3-degraded-bg)' },
}

const incidentTones: Record<IncidentImpact, { color: string; bg: string }> = {
  minor:    { color: 'var(--m3-degraded)', bg: 'var(--m3-degraded-bg)' },
  major:    { color: 'var(--m3-partial)',  bg: 'var(--m3-partial-bg)' },
  critical: { color: 'var(--m3-down)',     bg: 'var(--m3-down-bg)' },
}

function Chip({ icon, color, bg, children }: { icon: string; color: string; bg: string; children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-sans font-semibold px-2.5 py-0.5 rounded-full"
      style={{ background: bg, color }}
    >
      <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 14 }}>{icon}</span>
      {children}
    </span>
  )
}

/** Chips for a running maintenance window and an open incident, beside the status badge. */
export function ActivityBadges({ activity }: { activity: MonitorActivity }) {
  const incident = activity.incident
  return (
    <>
      {activity.maintenance && <Chip icon="construction" color="var(--m3-primary)" bg="var(--m3-primary-fixed)">Maintenance</Chip>}
      {incident && <Chip icon="warning" {...incidentTones[incident]}>Incident · {incident}</Chip>}
    </>
  )
}

/** The status visitors see: the check result with the monitor's open incident applied. */
export function effectiveStatus(monitor: Pick<MonitorWithActivity, 'currentStatus' | 'activity'>): MonitorStatus {
  return withIncidentImpact(monitor.currentStatus, monitor.activity?.incident)
}

/** The effective status, with the reason when an incident, not the checks, sets it. */
export function MonitorStatusBadge({ monitor }: { monitor: Pick<MonitorWithActivity, 'currentStatus' | 'activity'> }) {
  const status = effectiveStatus(monitor)
  return <StatusBadge status={status} reason={status !== monitor.currentStatus ? 'incident' : undefined} />
}

export function StatusBadge({ status, reason }: { status: MonitorStatus; reason?: string | undefined }) {
  const cfg = configs[status] ?? configs.pending
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-sans font-semibold px-2.5 py-0.5 rounded-full"
      style={{ background: cfg.bg, color: cfg.color }}
    >
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: cfg.color }} />
      {cfg.label}{reason && ` · ${reason}`}
    </span>
  )
}
