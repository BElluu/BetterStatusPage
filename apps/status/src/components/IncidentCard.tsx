import type { Incident, Monitor } from '@bsp/shared'

const statusColors: Record<string, string> = {
  investigating: '#ff4d6a',
  identified:    '#f97316',
  monitoring:    '#f5a623',
  resolved:      '#00d4af',
}

const statusLabels: Record<string, string> = {
  investigating: 'Investigating',
  identified:    'Identified',
  monitoring:    'Monitoring',
  resolved:      'Resolved',
}

const impactLabels: Record<string, string> = {
  none:     'No Impact',
  minor:    'Minor Impact',
  major:    'Major Impact',
  critical: 'Critical Impact',
}

export function IncidentCard({ incident, monitors = [] }: { incident: Incident; monitors?: Monitor[] }) {
  const color = statusColors[incident.status] ?? '#5a6a8a'

  const affectedMonitors = (incident.monitorIds ?? [])
    .map((id) => monitors.find((m) => m.id === id))
    .filter(Boolean) as Monitor[]

  return (
    <div
      className="glass rounded-xl overflow-hidden"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      {/* Header */}
      <div className="px-4 pt-4 pb-3 flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-display font-bold text-base leading-snug" style={{ color: 'var(--sig-text)' }}>
            {incident.title}
          </h3>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span
              className="text-xs font-medium px-2 py-0.5 rounded-full"
              style={{ background: `${color}18`, color, border: `1px solid ${color}30` }}
            >
              {statusLabels[incident.status] ?? incident.status}
            </span>
            <span className="text-xs" style={{ color: 'var(--sig-text-muted)' }}>
              {impactLabels[incident.impact] ?? incident.impact}
            </span>
          </div>
        </div>
        <span className="font-mono text-xs flex-shrink-0 mt-0.5" style={{ color: 'var(--sig-text-muted)' }}>
          {new Date(incident.startedAt).toLocaleDateString()}
        </span>
      </div>

      {/* Affected monitors */}
      {affectedMonitors.length > 0 && (
        <div className="px-4 pb-3 flex flex-wrap gap-1.5">
          {affectedMonitors.map((m) => (
            <span
              key={m.id}
              className="text-xs px-2 py-0.5 rounded-full font-mono"
              style={{
                background: 'rgba(255,255,255,0.05)',
                color: 'var(--sig-text-muted)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              {m.name}
            </span>
          ))}
        </div>
      )}

      {/* Updates timeline */}
      {(incident.updates ?? []).length > 0 && (
        <div
          className="px-4 pb-4 space-y-3"
          style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
        >
          <div className="pt-3 space-y-3">
            {(incident.updates ?? []).slice(0, 3).map((update, i) => (
              <div key={update.id} className="flex gap-3">
                {/* Timeline line */}
                <div className="flex flex-col items-center flex-shrink-0">
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0 mt-0.5"
                    style={{ background: i === 0 ? color : 'rgba(255,255,255,0.12)' }}
                  />
                  {i < (incident.updates ?? []).slice(0, 3).length - 1 && (
                    <div className="w-px flex-1 mt-1" style={{ background: 'rgba(255,255,255,0.07)', minHeight: 16 }} />
                  )}
                </div>
                {/* Content */}
                <div className="flex-1 min-w-0 pb-1">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <span className="text-xs font-medium" style={{ color: i === 0 ? color : 'var(--sig-text-muted)' }}>
                      {statusLabels[update.status] ?? update.status}
                    </span>
                    <span className="font-mono text-xs" style={{ color: 'var(--sig-text-muted)' }}>
                      {new Date(update.postedAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--sig-text)' }}>
                    {update.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
