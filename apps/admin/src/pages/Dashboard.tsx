import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Monitor, Incident } from '@bsp/shared'
import { StatusBadge } from '../components/monitors/StatusBadge'

const impactColors: Record<string, string> = {
  critical: '#ff4d6a',
  major:    '#f97316',
  minor:    '#f5a623',
  none:     '#5a6a8a',
}

export default function DashboardPage() {
  const { data: monitors = [] } = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
    refetchInterval: 15_000,
  })

  const { data: incidents = [] } = useQuery<Incident[]>({
    queryKey: ['incidents'],
    queryFn: () => api.get('/admin/incidents'),
  })

  const up       = monitors.filter((m) => m.currentStatus === 'up').length
  const down     = monitors.filter((m) => m.currentStatus === 'down').length
  const degraded = monitors.filter((m) => m.currentStatus === 'degraded').length
  const pending  = monitors.filter((m) => m.currentStatus === 'pending').length

  const activeIncidents = incidents.filter((i) => i.status !== 'resolved')

  const stats = [
    { label: 'Operational', count: up,       color: 'var(--sig-teal)', bg: 'rgba(0,212,175,0.08)', border: 'rgba(0,212,175,0.2)', icon: '↑' },
    { label: 'Down',        count: down,     color: 'var(--sig-red)',  bg: 'rgba(255,77,106,0.08)', border: 'rgba(255,77,106,0.2)', icon: '↓' },
    { label: 'Degraded',    count: degraded, color: 'var(--sig-amber)', bg: 'rgba(245,166,35,0.08)', border: 'rgba(245,166,35,0.2)', icon: '~' },
    { label: 'Pending',     count: pending,  color: 'var(--sig-text-muted)', bg: 'rgba(90,106,138,0.08)', border: 'rgba(90,106,138,0.2)', icon: '?' },
  ]

  return (
    <div className="p-8 space-y-8 fade-up">
      {/* Page header */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display font-bold text-2xl" style={{ color: 'var(--sig-text)' }}>Dashboard</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--sig-text-muted)' }}>
            System overview · {monitors.length} monitor{monitors.length !== 1 ? 's' : ''}
          </p>
        </div>
        <span className="font-mono text-xs" style={{ color: 'var(--sig-text-muted)' }}>
          Live · 15s refresh
        </span>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="glass rounded-xl p-5"
            style={{ background: stat.bg, borderColor: stat.border }}
          >
            <div className="flex items-start justify-between mb-3">
              <span
                className="font-mono text-xs font-medium px-1.5 py-0.5 rounded"
                style={{ background: `${stat.border}`, color: stat.color }}
              >
                {stat.icon}
              </span>
            </div>
            <div className="font-mono font-bold text-4xl leading-none" style={{ color: stat.color }}>
              {stat.count}
            </div>
            <div className="text-xs mt-2 font-medium" style={{ color: 'var(--sig-text-muted)' }}>
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      {/* Active Incidents */}
      {activeIncidents.length > 0 && (
        <div>
          <SectionHeader>Active Incidents</SectionHeader>
          <div className="space-y-2 mt-3">
            {activeIncidents.map((incident) => {
              const color = impactColors[incident.impact] ?? 'var(--sig-text-muted)'
              return (
                <div
                  key={incident.id}
                  className="glass rounded-xl px-4 py-3.5 flex items-center justify-between gap-4"
                  style={{ borderLeft: `3px solid ${color}` }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="min-w-0">
                      <span className="text-sm font-medium" style={{ color: 'var(--sig-text)' }}>
                        {incident.title}
                      </span>
                      <span className="ml-2 font-mono text-xs" style={{ color: 'var(--sig-text-muted)' }}>
                        {incident.status}
                      </span>
                    </div>
                  </div>
                  <span
                    className="text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 font-mono"
                    style={{ background: `${color}18`, color, border: `1px solid ${color}30` }}
                  >
                    {incident.impact}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Monitor table */}
      <div>
        <SectionHeader>All Monitors</SectionHeader>
        <div className="glass rounded-xl overflow-hidden mt-3" style={{ borderRadius: 12 }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--sig-border)' }}>
                {['Name', 'Type', 'Status', 'Last Check'].map((h) => (
                  <th
                    key={h}
                    className="text-left px-4 py-3 font-mono text-xs uppercase tracking-wider"
                    style={{ color: 'var(--sig-text-muted)' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {monitors.map((monitor, i) => (
                <tr
                  key={monitor.id}
                  className="glass-hover transition-colors"
                  style={{ borderTop: i > 0 ? '1px solid var(--sig-border)' : 'none' }}
                >
                  <td className="px-4 py-3 font-medium" style={{ color: 'var(--sig-text)' }}>
                    {monitor.name}
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs uppercase" style={{ color: 'var(--sig-text-muted)' }}>
                      {monitor.type}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={monitor.currentStatus} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--sig-text-muted)' }}>
                    {monitor.lastCheckedAt
                      ? new Date(monitor.lastCheckedAt).toLocaleTimeString()
                      : '—'}
                  </td>
                </tr>
              ))}
              {monitors.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-sm" style={{ color: 'var(--sig-text-muted)' }}>
                    No monitors yet. Add one in the Monitors section.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-mono text-xs uppercase tracking-widest font-medium" style={{ color: 'var(--sig-text-muted)' }}>
      {children}
    </h2>
  )
}
