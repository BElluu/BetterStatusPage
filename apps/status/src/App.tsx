import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useSSE } from './hooks/useSSE'
import type { Branding, Incident, Monitor, LayoutTree } from '@bsp/shared'
import { PageRenderer } from './components/PageRenderer'
import { IncidentCard } from './components/IncidentCard'

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

  const liveMonitors = monitors.map((m) => ({
    ...m,
    currentStatus: statusMap[m.id]?.status ?? m.currentStatus,
  }))

  // Resolved branding values (needed as real hex for opacity-appended strings like `${color}1a`)
  const b = {
    primaryColor: branding?.primaryColor ?? '#6366f1',
    accentColor: branding?.accentColor ?? '#f59e0b',
    backgroundColor: branding?.backgroundColor ?? '#0f172a',
    cardBackground: branding?.cardBackground ?? '#0f172a',
    cardBorderColor: branding?.cardBorderColor ?? '#1e293b',
    textColor: branding?.textColor ?? '#f8fafc',
    textMutedColor: branding?.textMutedColor ?? '#94a3b8',
    statusUpColor: branding?.statusUpColor ?? '#10b981',
    statusDownColor: branding?.statusDownColor ?? '#ef4444',
    statusDegradedColor: branding?.statusDegradedColor ?? '#f59e0b',
  }

  const cssVars = {
    '--bsp-bg': b.backgroundColor,
    '--bsp-card-bg': b.cardBackground,
    '--bsp-card-border': b.cardBorderColor,
    '--bsp-text': b.textColor,
    '--bsp-text-muted': b.textMutedColor,
    '--bsp-primary': b.primaryColor,
    '--bsp-accent': b.accentColor,
    '--bsp-up': b.statusUpColor,
    '--bsp-down': b.statusDownColor,
    '--bsp-degraded': b.statusDegradedColor,
    // Legacy vars kept for backwards compat (e.g. IncidentCard)
    '--primary': b.primaryColor,
    '--accent': b.accentColor,
    background: b.backgroundColor,
    minHeight: '100vh',
  } as React.CSSProperties

  const allUp = liveMonitors.length === 0 || liveMonitors.every((m) => m.currentStatus === 'up' || m.currentStatus === 'pending')
  const anyDown = liveMonitors.some((m) => m.currentStatus === 'down')
  const anyDegraded = liveMonitors.some((m) => m.currentStatus === 'degraded')

  const overallStatus = anyDown ? 'Major Outage' : anyDegraded ? 'Partial Degradation' : allUp ? 'All Systems Operational' : 'Checking…'
  const overallColor = anyDown ? b.statusDownColor : anyDegraded ? b.statusDegradedColor : b.statusUpColor

  // Branding class styles injected BEFORE customCss so user CSS can override via cascade
  const brandingStyles = `
.bsp-monitor-card { background: ${b.cardBackground}; border: 1px solid ${b.cardBorderColor}; border-radius: 8px; }
.bsp-group-card { background: ${b.cardBackground}; border: 1px solid ${b.cardBorderColor}; }
.bsp-divider { border-top-color: ${b.cardBorderColor}; }
.bsp-footer { color: ${b.textMutedColor}; border-top-color: ${b.cardBorderColor}; }
.bsp-text-block { color: ${b.textMutedColor}; }
.bsp-monitor-name { color: ${b.textColor}; }
.bsp-group-label { color: ${b.textColor}; }
.bsp-site-name { color: ${b.textColor}; }
`

  return (
    <div className="bsp-page" style={cssVars}>
      <style>{brandingStyles}</style>
      {branding?.customCss && <style>{branding.customCss}</style>}

      <div className="max-w-3xl mx-auto px-4 py-12 space-y-8">
        {/* Header */}
        <header className="bsp-header space-y-3">
          <div className="flex items-center gap-3">
            {branding?.logoUrl && (
              <img src={branding.logoUrl} alt="Logo" className="h-8 object-contain" />
            )}
            <h1 className="bsp-site-name text-2xl font-bold" style={{ color: b.textColor }}>
              {branding?.siteName ?? 'Status Page'}
            </h1>
          </div>
          <div
            className="bsp-status-banner flex items-center gap-3 rounded-xl px-5 py-4"
            style={{ background: `${overallColor}1a`, border: `1px solid ${overallColor}44` }}
          >
            <span
              className="w-3 h-3 rounded-full"
              style={{ background: overallColor, boxShadow: anyDown ? `0 0 8px ${overallColor}` : 'none' }}
            />
            <span className="font-semibold" style={{ color: b.textColor }}>{overallStatus}</span>
          </div>
        </header>

        {/* Active incidents */}
        {activeIncidents.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: b.textMutedColor }}>Active Incidents</h2>
            {activeIncidents.map((incident) => (
              <IncidentCard key={incident.id} incident={incident} />
            ))}
          </section>
        )}

        {/* Layout */}
        {tree && tree.children.length > 0 ? (
          <PageRenderer tree={tree} monitors={liveMonitors} statusMap={statusMap} />
        ) : (
          <section className="space-y-2">
            {liveMonitors.map((monitor) => (
              <FallbackMonitorRow key={monitor.id} monitor={monitor} responseMs={statusMap[monitor.id]?.responseMs ?? null} b={b} />
            ))}
          </section>
        )}

        {/* Incident history */}
        {incidents.filter((i) => i.status === 'resolved').length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: b.textMutedColor }}>Recent Incidents</h2>
            {incidents.filter((i) => i.status === 'resolved').map((incident) => (
              <IncidentCard key={incident.id} incident={incident} />
            ))}
          </section>
        )}

        {/* Footer */}
        <footer className="bsp-footer text-center text-xs pt-4" style={{ color: b.textMutedColor, borderTop: `1px solid ${b.cardBorderColor}` }}>
          Last updated: {new Date().toLocaleTimeString()}
        </footer>
      </div>
    </div>
  )
}

function FallbackMonitorRow({ monitor, responseMs, b }: {
  monitor: Monitor
  responseMs: number | null
  b: Record<string, string>
}) {
  const statusColor = {
    up: b['statusUpColor']!, down: b['statusDownColor']!, degraded: b['statusDegradedColor']!, pending: b['textMutedColor']!,
  }
  const statusLabel = { up: 'Operational', down: 'Down', degraded: 'Degraded', pending: 'Checking' }
  const color = statusColor[monitor.currentStatus] ?? statusColor['pending']!
  const label = statusLabel[monitor.currentStatus as keyof typeof statusLabel] ?? 'Checking'

  return (
    <div
      className="bsp-monitor-card flex items-center justify-between py-3 px-4 rounded-lg"
      style={{ background: b['cardBackground']!, border: `1px solid ${b['cardBorderColor']!}` }}
    >
      <div className="flex items-center gap-3">
        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: color }} />
        <span className="bsp-monitor-name text-sm" style={{ color: b['textColor']! }}>{monitor.name}</span>
        <span className="bsp-monitor-type text-xs uppercase" style={{ color: b['textMutedColor']! }}>{monitor.type}</span>
      </div>
      <div className="flex items-center gap-3 text-xs">
        {responseMs !== null && <span style={{ color: b['textMutedColor']! }}>{responseMs}ms</span>}
        <span className="bsp-monitor-status" style={{ color }}>{label}</span>
      </div>
    </div>
  )
}
