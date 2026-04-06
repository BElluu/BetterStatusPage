import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { useSSE } from './hooks/useSSE'
import { useDarkMode } from './hooks/useDarkMode'
import { useLocale } from './i18n/LocaleContext'
import type { Branding, Incident, Monitor, LayoutTree } from '@bsp/shared'
import { PageRenderer } from './components/PageRenderer'
import { IncidentCard } from './components/IncidentCard'
import { LanguageSwitcher } from './components/LanguageSwitcher'

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
  const [isDark, toggleDark] = useDarkMode()
  const [eventsTab, setEventsTab] = useState<'active' | 'history'>('active')
  const { t } = useLocale()

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
    queryFn: () => fetch('/api/v1/public/incidents?limit=10').then((r) => r.json()),
  })

  const branding = layoutData?.branding ?? status?.branding
  const tree = layoutData?.tree
  const monitors = status?.monitors ?? []
  const activeIncidents = status?.activeIncidents ?? []

  const liveMonitors = monitors.map((m) => ({
    ...m,
    currentStatus: statusMap[m.id]?.status ?? m.currentStatus,
  }))

  const brandingEnabled = !!(branding?.enabled)

  const allUp = liveMonitors.length === 0 || liveMonitors.every((m) => m.currentStatus === 'up' || m.currentStatus === 'pending')
  const allDown = liveMonitors.length > 0 && liveMonitors.every((m) => m.currentStatus === 'down')
  const someDown = !allDown && liveMonitors.some((m) => m.currentStatus === 'down')
  const anyDegraded = liveMonitors.some((m) => m.currentStatus === 'degraded')
  const hasActiveIncidents = activeIncidents.length > 0

  const overallStatus = allDown
    ? t('overall.majorOutage')
    : someDown
    ? t('overall.partialOutage')
    : anyDegraded
    ? t('overall.partialDegradation')
    : hasActiveIncidents
    ? t('overall.incidentsInProgress')
    : allUp
    ? t('overall.allOperational')
    : t('overall.checking')

  const overallColor = allDown
    ? (brandingEnabled ? branding!.statusDownColor : '#ba1a1a')
    : someDown
    ? (brandingEnabled ? branding!.statusDownColor : '#ea580c')
    : anyDegraded
    ? (brandingEnabled ? branding!.statusDegradedColor : '#eab308')
    : hasActiveIncidents
    ? '#eab308'
    : (brandingEnabled ? branding!.statusUpColor : '#22c55e')

  const resolvedIncidents = incidents.filter((i) => i.status === 'resolved')

  const cssVars: React.CSSProperties = brandingEnabled ? {
    '--bsp-bg': branding!.backgroundColor,
    '--bsp-card-bg': branding!.cardBackground,
    '--bsp-card-border': branding!.cardBorderColor,
    '--bsp-text': branding!.textColor,
    '--bsp-text-muted': branding!.textMutedColor,
    '--bsp-primary': branding!.primaryColor,
    '--bsp-accent': branding!.accentColor,
    '--bsp-up': branding!.statusUpColor,
    '--bsp-down': branding!.statusDownColor,
    '--bsp-degraded': branding!.statusDegradedColor,
    '--color-primary': branding!.primaryColor,
    '--color-accent': branding!.accentColor,
  } as React.CSSProperties : {}

  const brandingStyles = brandingEnabled ? `
.bsp-monitor-card { background: ${branding!.cardBackground}; border: 1px solid ${branding!.cardBorderColor}; border-radius: 16px; overflow: hidden; }
.bsp-group-card { background: ${branding!.cardBackground}; border: 1px solid ${branding!.cardBorderColor}; border-radius: 16px; }
.bsp-divider { border-top-color: ${branding!.cardBorderColor}; }
.bsp-footer { color: ${branding!.textMutedColor}; border-top-color: ${branding!.cardBorderColor}; }
.bsp-text-block { color: ${branding!.textMutedColor}; }
.bsp-monitor-name { color: ${branding!.textColor}; }
.bsp-group-label { color: ${branding!.textColor}; }
.bsp-site-name { color: ${branding!.textColor}; }
` : ''

  const siteName = branding?.siteName || 'Status Page'
  document.title = siteName

  return (
    <div className="bsp-page" style={{ ...cssVars, background: 'var(--m3-surface)', minHeight: '100vh' }}>
      {brandingStyles && <style>{brandingStyles}</style>}
      {branding?.customCss && <style>{branding.customCss}</style>}

      {/* ── Top Navigation ── */}
      <header style={{ background: 'var(--m3-surface)', position: 'sticky', top: 0, zIndex: 50 }}>
        <nav className="flex justify-between items-center px-8 py-5 max-w-[1440px] mx-auto">
          {/* Logo */}
          <div className="flex items-center">
            {branding?.logoType === 'text' && branding.logoText ? (
              <span
                className="bsp-site-name font-headline font-extrabold"
                style={{ fontSize: '22px', color: 'var(--m3-on-surface)', letterSpacing: '-0.01em' }}
              >
                {branding.logoText}
              </span>
            ) : branding?.logoUrl ? (
              <img src={branding.logoUrl} alt={siteName} style={{ height: '40px', maxWidth: '200px', objectFit: 'contain' }} />
            ) : (
              <img
                src={isDark ? '/logo_dark.png' : '/logo_light.png'}
                alt={siteName}
                style={{ height: '36px', objectFit: 'contain' }}
              />
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            {!brandingEnabled && (
              <button
                onClick={toggleDark}
                className="p-2 rounded-full transition-all active:scale-95"
                style={{ color: 'var(--m3-secondary)' }}
                onMouseEnter={(e) => { (e.currentTarget).style.background = 'var(--m3-surface-container)' }}
                onMouseLeave={(e) => { (e.currentTarget).style.background = '' }}
                aria-label="Toggle dark mode"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '22px' }}>
                  {isDark ? 'light_mode' : 'dark_mode'}
                </span>
              </button>
            )}
          </div>
        </nav>
      </header>

      <main className="max-w-[1440px] mx-auto px-8" id="status">

        {/* ── Hero ── */}
        <section className="py-20 flex flex-col items-center text-center fade-up" style={{ animationDelay: '0ms' }}>
          <div
            className="inline-flex items-center gap-3 px-4 py-2 rounded-full mb-8"
            style={{ background: 'var(--m3-surface-container-high)' }}
          >
            <span className="w-2.5 h-2.5 rounded-full animate-pulse" style={{ background: overallColor }} />
            <span className="text-sm font-semibold tracking-wide font-label uppercase" style={{ color: 'var(--m3-on-surface-variant)' }}>
              {t('page.hero')}
            </span>
          </div>

          <h1
            className="font-headline font-extrabold tracking-tight leading-[1.02] mb-6"
            style={{
              fontSize: 'clamp(2.5rem, 7vw, 5.5rem)',
              color: brandingEnabled ? branding!.textColor : 'var(--m3-on-surface)',
            }}
          >
            {overallStatus}
          </h1>

          <p className="text-xl max-w-2xl mx-auto leading-relaxed" style={{ color: 'var(--m3-secondary)' }}>
            {t('page.monitoredLine', { n: liveMonitors.length })}
            {activeIncidents.length > 0 && ` ${t('page.incidentLine', { n: activeIncidents.length })}`}
          </p>
        </section>

        {/* ── Main content — always from PageRenderer when tree exists ── */}
        {tree && tree.children.length > 0 ? (
          <section className="mb-32 fade-up" style={{ animationDelay: '80ms' }}>
            <PageRenderer
              tree={tree}
              monitors={liveMonitors}
              statusMap={statusMap}
              activeIncidents={activeIncidents}
              allIncidents={incidents}
            />
          </section>
        ) : liveMonitors.length > 0 ? (
          /* Fallback bento grid when no Page Builder layout is configured */
          <section className="mb-32 fade-up" style={{ animationDelay: '80ms' }}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              {liveMonitors.map((monitor, i) => (
                <ServiceCard
                  key={monitor.id}
                  monitor={monitor}
                  responseMs={statusMap[monitor.id]?.responseMs ?? null}
                  animDelay={100 + i * 40}
                />
              ))}
            </div>
          </section>
        ) : null}

        {/* ── Events Section (shown when NOT using tree-based incidents block) ── */}
        {(!tree || tree.children.length === 0) && (activeIncidents.length > 0 || resolvedIncidents.length > 0) && (
          <section className="mb-32 fade-up" id="events" style={{ animationDelay: '160ms' }}>
            {/* Section header + tabs */}
            <div className="flex items-center justify-between mb-12">
              <h2 className="font-headline text-3xl font-extrabold tracking-tight" style={{ color: 'var(--m3-on-surface)' }}>
                {t('section.systemEvents')}
              </h2>
              <div className="flex gap-1 p-1 rounded-xl" style={{ background: 'var(--m3-surface-container)' }}>
                <button
                  onClick={() => setEventsTab('active')}
                  className="px-5 py-2 rounded-lg text-sm font-bold transition-all"
                  style={{
                    background: eventsTab === 'active' ? 'var(--m3-surface-container-lowest)' : 'transparent',
                    color: eventsTab === 'active' ? 'var(--m3-on-surface)' : 'var(--m3-secondary)',
                    boxShadow: eventsTab === 'active' ? '0 1px 4px rgba(19,27,46,0.08)' : 'none',
                  }}
                >
                  {t('tab.active')}
                </button>
                <button
                  onClick={() => setEventsTab('history')}
                  className="px-5 py-2 rounded-lg text-sm font-bold transition-all"
                  style={{
                    background: eventsTab === 'history' ? 'var(--m3-surface-container-lowest)' : 'transparent',
                    color: eventsTab === 'history' ? 'var(--m3-on-surface)' : 'var(--m3-secondary)',
                    boxShadow: eventsTab === 'history' ? '0 1px 4px rgba(19,27,46,0.08)' : 'none',
                  }}
                >
                  {t('tab.history')}
                </button>
              </div>
            </div>

            {eventsTab === 'active' ? (
              <div className="space-y-6">
                {activeIncidents.length > 0 ? (
                  activeIncidents.map((incident, i) => (
                    <div key={incident.id} className="fade-up" style={{ animationDelay: `${200 + i * 60}ms` }}>
                      <IncidentCard incident={incident} monitors={liveMonitors} />
                    </div>
                  ))
                ) : (
                  <div
                    className="p-12 rounded-xl text-center"
                    style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}
                  >
                    <span className="material-symbols-outlined block mb-3" style={{ fontSize: '32px', color: '#22c55e' }}>
                      check_circle
                    </span>
                    <p className="font-sans font-medium" style={{ color: 'var(--m3-secondary)' }}>
                      {t('empty.noActiveIncidents')}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {resolvedIncidents.length > 0 ? (
                  resolvedIncidents.map((incident, i) => (
                    <div key={incident.id} className="fade-up" style={{ animationDelay: `${200 + i * 40}ms` }}>
                      <HistoryRow incident={incident} />
                    </div>
                  ))
                ) : (
                  <div
                    className="p-12 rounded-xl text-center"
                    style={{ background: 'var(--m3-surface-container-low)' }}
                  >
                    <p className="font-sans text-sm" style={{ color: 'var(--m3-secondary)' }}>
                      {t('empty.noHistory')}
                    </p>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* ── Footer ── */}
        <footer
          className="bsp-footer text-center py-12 mt-4"
          style={{
            color: 'var(--m3-secondary)',
            borderTop: '0',
          }}
        >
          <img src={isDark ? '/logo_dark.png' : '/logo_light.png'} alt={siteName} style={{ height: '80px', objectFit: 'contain', margin: '0 auto 16px', opacity: 0.75 }} />
          <p className="text-xs uppercase tracking-widest">{siteName}</p>
        </footer>
      </main>
    </div>
  )
}

/* ── Service Card (bento monitor tile) ───────────────────────────── */
function ServiceCard({
  monitor,
  responseMs,
  animDelay,
}: {
  monitor: Monitor
  responseMs: number | null
  animDelay: number
}) {
  const { t } = useLocale()
  const isUp       = monitor.currentStatus === 'up'
  const isDown     = monitor.currentStatus === 'down'
  const isDegraded = monitor.currentStatus === 'degraded'

  const statusLabel = isUp ? t('status.operational') : isDown ? t('status.outage') : isDegraded ? t('status.degraded') : t('status.checking')
  const statusBg    = isUp ? 'rgba(34,197,94,0.1)'  : isDown ? '#ffdad6' : isDegraded ? 'rgba(234,179,8,0.12)' : 'var(--m3-surface-container)'
  const statusColor = isUp ? '#166534' : isDown ? '#ba1a1a' : isDegraded ? '#854d0e' : 'var(--m3-secondary)'

  // Generate 40 uptime bars — color from current status
  const barColor = isDown ? '#ba1a1a' : isDegraded ? '#eab308' : '#22c55e'
  const barColorLight = isDown ? '#f28b82' : isDegraded ? '#fcd34d' : '#4ade80'

  return (
    <div
      className="bsp-monitor-card fade-up"
      style={{ padding: '28px', animationDelay: `${animDelay}ms` }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
        <div>
          <h3 className="font-headline font-bold" style={{ fontSize: '28px', lineHeight: 1.15, color: 'var(--bsp-text)', margin: 0 }}>
            {monitor.name}
          </h3>
          <p className="font-mono uppercase" style={{ fontSize: '11px', letterSpacing: '0.09em', color: 'var(--m3-secondary)', marginTop: '4px' }}>
            {monitor.type.toUpperCase()}{responseMs !== null && ` · ${responseMs}ms`}
          </p>
        </div>
        <span
          style={{
            background: statusBg, color: statusColor,
            padding: '6px 14px', borderRadius: '999px',
            fontSize: '13px', fontWeight: 700,
            display: 'flex', alignItems: 'center', gap: '6px',
            flexShrink: 0, marginLeft: '16px',
          }}
        >
          {(isDown || isDegraded) && (
            <span className="animate-pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor, display: 'inline-block' }} />
          )}
          {statusLabel}
        </span>
      </div>

      {/* Uptime labels + bars */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <span style={{ fontSize: '10px', fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--m3-secondary)' }}>{t('uptime.daysAgo', { n: 90 })}</span>
          <span style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--m3-on-surface)' }}>
            {isUp ? t('uptime.pct', { pct: '99.9' }) : isDown ? t('status.outage') : isDegraded ? t('status.degraded') : t('status.checking')}
          </span>
          <span style={{ fontSize: '10px', fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--m3-secondary)' }}>{t('uptime.today')}</span>
        </div>
        <div className="flex h-10" style={{ gap: '2px' }}>
          {Array.from({ length: 40 }).map((_, i) => (
            <div
              key={i}
              className="flex-1 rounded-sm"
              style={{ background: `linear-gradient(to top, ${barColor}, ${barColorLight})` }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/* ── History Row (resolved incidents) ────────────────────────────── */
function HistoryRow({ incident }: { incident: Incident }) {
  return (
    <div
      className="grid grid-cols-3 items-center px-8 py-5 rounded-xl transition-all"
      style={{
        background: 'var(--m3-surface-container-low)',
        border: '1px solid var(--m3-outline-variant)',
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLDivElement).style.background = 'var(--m3-surface-container)'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLDivElement).style.background = 'var(--m3-surface-container-low)'
      }}
    >
      <div>
        <span className="font-label text-xs uppercase tracking-widest block" style={{ color: 'var(--m3-secondary)' }}>
          {new Date(incident.startedAt).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
      </div>
      <div>
        <h4 className="font-bold font-sans text-sm" style={{ color: 'var(--m3-on-surface)' }}>{incident.title}</h4>
        <p className="text-xs mt-0.5" style={{ color: 'var(--m3-secondary)' }}>{incident.impact} impact</p>
      </div>
      <div className="text-right">
        <span
          className="px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider"
          style={{ background: 'var(--m3-up-bg)', color: 'var(--m3-up)' }}
        >
          Resolved
        </span>
      </div>
    </div>
  )
}
