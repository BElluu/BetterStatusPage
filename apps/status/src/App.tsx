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

const impactColor: Record<string, string> = {
  none: '#00d4af',
  minor: '#f5a623',
  major: '#f97316',
  critical: '#ff4d6a',
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

  const b = {
    primaryColor: branding?.primaryColor ?? '#00d4af',
    accentColor: branding?.accentColor ?? '#f5a623',
    backgroundColor: branding?.backgroundColor ?? '#080d18',
    cardBackground: branding?.cardBackground ?? '#0d1526',
    cardBorderColor: branding?.cardBorderColor ?? 'rgba(255,255,255,0.07)',
    textColor: branding?.textColor ?? '#e8edf5',
    textMutedColor: branding?.textMutedColor ?? '#5a6a8a',
    statusUpColor: branding?.statusUpColor ?? '#00d4af',
    statusDownColor: branding?.statusDownColor ?? '#ff4d6a',
    statusDegradedColor: branding?.statusDegradedColor ?? '#f5a623',
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
    '--primary': b.primaryColor,
    '--accent': b.accentColor,
    background: b.backgroundColor,
    minHeight: '100vh',
  } as React.CSSProperties

  const brandingStyles = `
.bsp-monitor-card { background: ${b.cardBackground}; border: 1px solid ${b.cardBorderColor}; border-radius: 10px; overflow: hidden; }
.bsp-group-card { background: ${b.cardBackground}; border: 1px solid ${b.cardBorderColor}; }
.bsp-divider { border-top-color: ${b.cardBorderColor}; }
.bsp-footer { color: ${b.textMutedColor}; border-top-color: ${b.cardBorderColor}; }
.bsp-text-block { color: ${b.textMutedColor}; }
.bsp-monitor-name { color: ${b.textColor}; }
.bsp-group-label { color: ${b.textColor}; }
.bsp-site-name { color: ${b.textColor}; }
`

  const allUp = liveMonitors.length === 0 || liveMonitors.every((m) => m.currentStatus === 'up' || m.currentStatus === 'pending')
  const anyDown = liveMonitors.some((m) => m.currentStatus === 'down')
  const anyDegraded = liveMonitors.some((m) => m.currentStatus === 'degraded')
  const hasActiveIncidents = activeIncidents.length > 0

  const overallStatus = anyDown
    ? 'Major Outage'
    : anyDegraded
    ? 'Partial Degradation'
    : hasActiveIncidents
    ? 'Incidents in Progress'
    : allUp
    ? 'All Systems Operational'
    : 'Checking…'

  const overallColor = anyDown
    ? b.statusDownColor
    : anyDegraded
    ? b.statusDegradedColor
    : hasActiveIncidents
    ? '#f5a623'
    : b.statusUpColor

  const resolvedIncidents = incidents.filter((i) => i.status === 'resolved')

  return (
    <div className="bsp-page bg-grid" style={cssVars}>
      <style>{brandingStyles}</style>
      {branding?.customCss && <style>{branding.customCss}</style>}

      <div className="max-w-3xl mx-auto px-4 py-14 space-y-10">

        {/* ── Header ── */}
        <header className="bsp-header space-y-6 fade-up" style={{ animationDelay: '0ms' }}>
          <div className="flex items-center gap-3">
            {branding?.logoUrl && (
              <img src={branding.logoUrl} alt="Logo" className="h-8 object-contain" />
            )}
            <span
              className="bsp-site-name font-display text-lg font-semibold tracking-tight"
              style={{ color: b.textColor }}
            >
              {branding?.siteName ?? 'Status Page'}
            </span>
          </div>

          {/* Status orb + headline */}
          <div className="flex items-center gap-5">
            {/* Orb */}
            <div className="relative flex-shrink-0" style={{ width: 18, height: 18 }}>
              <span
                className="status-orb-ring"
                style={{ color: overallColor, background: overallColor, opacity: 0.25 }}
              />
              <span
                className="status-orb-dot block w-full h-full rounded-full"
                style={{ background: overallColor, color: overallColor }}
              />
            </div>

            <div>
              <h1
                className="font-display text-3xl font-bold tracking-tight leading-none"
                style={{ color: b.textColor }}
              >
                {overallStatus}
              </h1>
              <p className="text-sm mt-1.5" style={{ color: b.textMutedColor }}>
                {liveMonitors.length} {liveMonitors.length === 1 ? 'service' : 'services'} monitored
              </p>
            </div>
          </div>
        </header>

        {/* ── Active incidents ── */}
        {activeIncidents.length > 0 && (
          <section className="space-y-3 fade-up" style={{ animationDelay: '80ms' }}>
            <SectionLabel color={b.textMutedColor}>Active Incidents</SectionLabel>
            {activeIncidents.map((incident, i) => (
              <div
                key={incident.id}
                className="fade-up"
                style={{ animationDelay: `${120 + i * 60}ms` }}
              >
                <IncidentCard incident={incident} monitors={liveMonitors} />
              </div>
            ))}
          </section>
        )}

        {/* ── Monitor layout ── */}
        <section className="fade-up" style={{ animationDelay: '160ms' }}>
          {tree && tree.children.length > 0 ? (
            <PageRenderer tree={tree} monitors={liveMonitors} statusMap={statusMap} />
          ) : (
            <div className="space-y-2">
              {liveMonitors.map((monitor, i) => (
                <div
                  key={monitor.id}
                  className="fade-up"
                  style={{ animationDelay: `${200 + i * 40}ms` }}
                >
                  <FallbackMonitorRow monitor={monitor} responseMs={statusMap[monitor.id]?.responseMs ?? null} b={b} />
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Incident history ── */}
        {resolvedIncidents.length > 0 && (
          <section className="space-y-3 fade-up" style={{ animationDelay: '240ms' }}>
            <SectionLabel color={b.textMutedColor}>Recent Incidents</SectionLabel>
            {resolvedIncidents.map((incident, i) => (
              <div
                key={incident.id}
                className="fade-up"
                style={{ animationDelay: `${280 + i * 60}ms` }}
              >
                <IncidentCard incident={incident} monitors={liveMonitors} />
              </div>
            ))}
          </section>
        )}

        {/* ── Footer ── */}
        <footer
          className="bsp-footer text-center text-xs pt-6 font-mono"
          style={{ color: b.textMutedColor, borderTop: `1px solid ${b.cardBorderColor}` }}
        >
          Last updated: {new Date().toLocaleTimeString()}
        </footer>
      </div>
    </div>
  )
}

function SectionLabel({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <h2
      className="font-mono text-xs uppercase tracking-widest font-medium flex items-center gap-2"
      style={{ color }}
    >
      <span className="flex-1 h-px" style={{ background: color, opacity: 0.2 }} />
      {children}
      <span className="flex-1 h-px" style={{ background: color, opacity: 0.2 }} />
    </h2>
  )
}

function FallbackMonitorRow({ monitor, responseMs, b }: {
  monitor: Monitor
  responseMs: number | null
  b: Record<string, string>
}) {
  const statusColor: Record<string, string> = {
    up: b['statusUpColor']!,
    down: b['statusDownColor']!,
    degraded: b['statusDegradedColor']!,
    pending: b['textMutedColor']!,
  }
  const statusLabel: Record<string, string> = { up: 'Operational', down: 'Down', degraded: 'Degraded', pending: 'Checking' }
  const color = statusColor[monitor.currentStatus] ?? statusColor['pending']!
  const label = statusLabel[monitor.currentStatus] ?? 'Checking'
  const isDown = monitor.currentStatus === 'down'
  const isDegraded = monitor.currentStatus === 'degraded'
  const showPulse = isDown || isDegraded

  return (
    <div
      className="bsp-monitor-card glass glass-hover flex items-center gap-3 py-3.5 px-4"
    >
      <div className="relative flex-shrink-0" style={{ width: 10, height: 10 }}>
        {showPulse && (
          <span
            className="monitor-dot-ring"
            style={{ background: color, opacity: 0.35 }}
          />
        )}
        <span className="block w-full h-full rounded-full" style={{ background: color }} />
      </div>
      <span className="bsp-monitor-name text-sm font-medium flex-1 min-w-0 truncate" style={{ color: b['textColor']! }}>
        {monitor.name}
      </span>
      <span className="text-xs uppercase tracking-wider font-mono" style={{ color: b['textMutedColor']! }}>
        {monitor.type}
      </span>
      {responseMs !== null && (
        <span className="font-mono text-xs" style={{ color: b['textMutedColor']! }}>
          {responseMs}ms
        </span>
      )}
      <span className="bsp-monitor-status text-xs font-medium" style={{ color }}>{label}</span>
    </div>
  )
}
