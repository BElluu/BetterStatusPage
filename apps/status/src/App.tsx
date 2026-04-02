import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useSSE } from './hooks/useSSE'
import type { Branding, Incident, Monitor, LayoutTree } from '@bsp/shared'
import { PageRenderer } from './components/PageRenderer'
import { IncidentCard } from './components/IncidentCard'
import Markdown from 'react-markdown'

interface PublicStatus {
  branding: Branding | null
  groups: unknown[]
  monitors: Monitor[]
  activeIncidents: Incident[]
}

interface PublicLayout {
  tree: LayoutTree
  branding: Branding | null
}

export default function App() {
  const qc = useQueryClient()

  const handleIncidentChange = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['public-status'] })
    qc.invalidateQueries({ queryKey: ['public-incidents'] })
  }, [qc])

  const statusMap = useSSE(handleIncidentChange)

  const { data: status } = useQuery<PublicStatus>({
    queryKey: ['public-status'],
    queryFn: () => fetch('/api/v1/public/status').then((r) => r.json()),
    refetchInterval: 60_000,
  })

  const { data: layoutData } = useQuery<PublicLayout>({
    queryKey: ['public-layout'],
    queryFn: () => fetch('/api/v1/public/layout').then((r) => r.json()),
  })

  const { data: incidents = [] } = useQuery<Incident[]>({
    queryKey: ['public-incidents'],
    queryFn: () => fetch('/api/v1/public/incidents?limit=5').then((r) => r.json()),
  })

  const branding = layoutData?.branding ?? status?.branding
  const tree = layoutData?.tree
  const monitors = status?.monitors ?? []
  const activeIncidents = status?.activeIncidents ?? []

  // Merge SSE live status into monitors
  const liveMonitors = monitors.map((m) => ({
    ...m,
    currentStatus: statusMap[m.id]?.status ?? m.currentStatus,
  }))

  // Apply branding CSS vars
  const primaryColor = branding?.primaryColor ?? '#6366f1'
  const accentColor = branding?.accentColor ?? '#f59e0b'

  const allUp = liveMonitors.length === 0 || liveMonitors.every((m) => m.currentStatus === 'up' || m.currentStatus === 'pending')
  const anyDown = liveMonitors.some((m) => m.currentStatus === 'down')
  const anyDegraded = liveMonitors.some((m) => m.currentStatus === 'degraded')

  const overallStatus = anyDown ? 'Major Outage' : anyDegraded ? 'Partial Degradation' : allUp ? 'All Systems Operational' : 'Checking…'
  const overallColor = anyDown ? '#ef4444' : anyDegraded ? '#f59e0b' : '#10b981'

  return (
    <div style={{ '--primary': primaryColor, '--accent': accentColor } as React.CSSProperties}>
      {/* Inject custom CSS */}
      {branding?.customCss && <style>{branding.customCss}</style>}

      <div className="max-w-3xl mx-auto px-4 py-12 space-y-8">
        {/* Header */}
        <header className="space-y-3">
          <div className="flex items-center gap-3">
            {branding?.logoUrl && (
              <img src={branding.logoUrl} alt="Logo" className="h-8 object-contain" />
            )}
            <h1 className="text-2xl font-bold text-white">
              {branding?.siteName ?? 'Status Page'}
            </h1>
          </div>

          {/* Overall status banner */}
          <div
            className="flex items-center gap-3 rounded-xl px-5 py-4"
            style={{ background: `${overallColor}18`, border: `1px solid ${overallColor}40` }}
          >
            <span
              className="w-3 h-3 rounded-full"
              style={{ background: overallColor, boxShadow: anyDown ? `0 0 8px ${overallColor}` : 'none' }}
            />
            <span className="font-semibold text-white">{overallStatus}</span>
          </div>
        </header>

        {/* Active incidents */}
        {activeIncidents.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Active Incidents</h2>
            {activeIncidents.map((incident) => (
              <IncidentCard key={incident.id} incident={incident} />
            ))}
          </section>
        )}

        {/* Services from layout */}
        {tree && tree.children.length > 0 ? (
          <PageRenderer tree={tree} monitors={liveMonitors} statusMap={statusMap} />
        ) : (
          <section className="space-y-2">
            {liveMonitors.map((monitor) => (
              <MonitorRow key={monitor.id} monitor={monitor} responseMs={statusMap[monitor.id]?.responseMs ?? null} />
            ))}
          </section>
        )}

        {/* Incident history */}
        {incidents.filter((i) => i.status === 'resolved').length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Recent Incidents</h2>
            {incidents.filter((i) => i.status === 'resolved').map((incident) => (
              <IncidentCard key={incident.id} incident={incident} />
            ))}
          </section>
        )}

        {/* Footer */}
        <footer className="text-center text-xs text-slate-600 pt-4 border-t border-slate-800">
          Last updated: {new Date().toLocaleTimeString()}
        </footer>
      </div>
    </div>
  )
}

function MonitorRow({ monitor, responseMs }: { monitor: Monitor; responseMs: number | null }) {
  const statusConfig = {
    up: { dot: '#10b981', label: 'Operational' },
    down: { dot: '#ef4444', label: 'Down' },
    degraded: { dot: '#f59e0b', label: 'Degraded' },
    pending: { dot: '#64748b', label: 'Checking' },
  }
  const cfg = statusConfig[monitor.currentStatus] ?? statusConfig.pending

  return (
    <div className="flex items-center justify-between py-3 px-4 bg-slate-900 rounded-lg border border-slate-800">
      <div className="flex items-center gap-3">
        <span
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ background: cfg.dot }}
        />
        <span className="text-white text-sm">{monitor.name}</span>
        <span className="text-xs text-slate-500 uppercase">{monitor.type}</span>
      </div>
      <div className="flex items-center gap-3 text-xs">
        {responseMs !== null && (
          <span className="text-slate-500">{responseMs}ms</span>
        )}
        <span style={{ color: cfg.dot }}>{cfg.label}</span>
      </div>
    </div>
  )
}
