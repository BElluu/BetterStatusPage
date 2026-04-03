import type { Incident, Monitor } from '@bsp/shared'

const statusColors: Record<string, string> = {
  investigating: '#ef4444',
  identified: '#f97316',
  monitoring: '#f59e0b',
  resolved: '#10b981',
}

const impactLabels: Record<string, string> = {
  none: 'No Impact',
  minor: 'Minor Impact',
  major: 'Major Impact',
  critical: 'Critical Impact',
}

export function IncidentCard({ incident, monitors = [] }: { incident: Incident; monitors?: Monitor[] }) {
  const color = statusColors[incident.status] ?? '#64748b'
  const affectedMonitors = (incident.monitorIds ?? [])
    .map((id) => monitors.find((m) => m.id === id))
    .filter(Boolean) as Monitor[]

  return (
    <div
      className="rounded-xl border p-4 space-y-3"
      style={{ background: `${color}0d`, borderColor: `${color}30` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-white font-medium">{incident.title}</h3>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: `${color}20`, color }}>
              {incident.status}
            </span>
            <span className="text-xs text-slate-400">{impactLabels[incident.impact] ?? incident.impact}</span>
          </div>
        </div>
        <span className="text-xs text-slate-500 whitespace-nowrap">
          {new Date(incident.startedAt).toLocaleDateString()}
        </span>
      </div>

      {affectedMonitors.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {affectedMonitors.map((m) => (
            <span
              key={m.id}
              className="text-xs px-2 py-0.5 rounded-full"
              style={{ background: `${color}15`, color: '#94a3b8', border: `1px solid ${color}25` }}
            >
              {m.name}
            </span>
          ))}
        </div>
      )}

      {(incident.updates ?? []).length > 0 && (
        <div className="space-y-2">
          {(incident.updates ?? []).slice(0, 3).map((update) => (
            <div key={update.id} className="border-l-2 pl-3" style={{ borderColor: `${color}50` }}>
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-xs font-medium" style={{ color }}>{update.status}</span>
                <span className="text-xs text-slate-500">{new Date(update.postedAt).toLocaleString()}</span>
              </div>
              <p className="text-sm text-slate-300">{update.body}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
