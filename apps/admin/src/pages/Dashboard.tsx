import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Monitor, Incident } from '@bsp/shared'
import { StatusBadge } from '../components/monitors/StatusBadge'

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

  const up = monitors.filter((m) => m.currentStatus === 'up').length
  const down = monitors.filter((m) => m.currentStatus === 'down').length
  const degraded = monitors.filter((m) => m.currentStatus === 'degraded').length
  const pending = monitors.filter((m) => m.currentStatus === 'pending').length

  const activeIncidents = incidents.filter((i) => i.status !== 'resolved')

  return (
    <div className="p-8 space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-white">Dashboard</h2>
        <p className="text-slate-400 text-sm mt-1">System overview</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Operational', count: up, color: 'text-emerald-400', bg: 'bg-emerald-400/10' },
          { label: 'Down', count: down, color: 'text-red-400', bg: 'bg-red-400/10' },
          { label: 'Degraded', count: degraded, color: 'text-amber-400', bg: 'bg-amber-400/10' },
          { label: 'Pending', count: pending, color: 'text-slate-400', bg: 'bg-slate-400/10' },
        ].map((stat) => (
          <div key={stat.label} className="bg-slate-900 rounded-xl border border-slate-800 p-5">
            <div className={`text-3xl font-bold ${stat.color}`}>{stat.count}</div>
            <div className="text-slate-400 text-sm mt-1">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Active Incidents */}
      {activeIncidents.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-3">Active Incidents</h3>
          <div className="space-y-2">
            {activeIncidents.map((incident) => (
              <div key={incident.id} className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 flex items-center justify-between">
                <div>
                  <span className="text-white font-medium">{incident.title}</span>
                  <span className="ml-3 text-xs text-slate-400">{incident.status}</span>
                </div>
                <span className={`text-xs px-2 py-1 rounded-full ${
                  incident.impact === 'critical' ? 'bg-red-500/20 text-red-400' :
                  incident.impact === 'major' ? 'bg-orange-500/20 text-orange-400' :
                  'bg-yellow-500/20 text-yellow-400'
                }`}>
                  {incident.impact}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Monitor table */}
      <div>
        <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-3">All Monitors</h3>
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="text-left text-slate-400 font-medium px-4 py-3">Name</th>
                <th className="text-left text-slate-400 font-medium px-4 py-3">Type</th>
                <th className="text-left text-slate-400 font-medium px-4 py-3">Status</th>
                <th className="text-left text-slate-400 font-medium px-4 py-3">Last Check</th>
              </tr>
            </thead>
            <tbody>
              {monitors.map((monitor) => (
                <tr key={monitor.id} className="border-b border-slate-800/50 last:border-0">
                  <td className="px-4 py-3 text-white">{monitor.name}</td>
                  <td className="px-4 py-3">
                    <span className="text-slate-400 uppercase text-xs">{monitor.type}</span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={monitor.currentStatus} />
                  </td>
                  <td className="px-4 py-3 text-slate-400">
                    {monitor.lastCheckedAt
                      ? new Date(monitor.lastCheckedAt).toLocaleTimeString()
                      : '—'}
                  </td>
                </tr>
              ))}
              {monitors.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
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
