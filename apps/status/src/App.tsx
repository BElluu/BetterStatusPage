import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getJSON } from './api'
import { useSSE } from './hooks/useSSE'
import { useDarkMode } from './hooks/useDarkMode'
import { useLocale } from './i18n/LocaleContext'
import type { Branding, Incident, PublicMonitor, MaintenanceWindow, LayoutTree, LayoutNode, GroupNode, MonitorNode } from '@bsp/shared'
import { PageRenderer } from './components/PageRenderer'
import { IncidentCard } from './components/IncidentCard'
import { LanguageSwitcher } from './components/LanguageSwitcher'
import { FEED_URL, SubscribeDialog, SubscriptionLinkDialog, clearSubscriptionLink, readSubscriptionLink, useSubscriptionOptions } from './components/Subscriptions'
import { applyIncidentStatus } from './utils/incidentStatus'
import { resolveBrandingCssVariables, resolveBrandingCustomCss, resolveBrandingLogoUrl } from './branding'

interface MonitorDependency {
  dependentId: number
  dependsOnId: number
}

interface PublicStatus {
  branding: Branding | null
  monitors: PublicMonitor[]
  activeIncidents: Incident[]
  activeMaintenanceWindows: MaintenanceWindow[]
  monitorDependencies: MonitorDependency[]
}

interface PublicLayout {
  tree: LayoutTree
  branding: Branding | null
}

const EMPTY_MONITORS: PublicMonitor[] = []
const EMPTY_MAINTENANCE_WINDOWS: MaintenanceWindow[] = []
const EMPTY_MONITOR_DEPENDENCIES: MonitorDependency[] = []

function collectLayoutMonitorIds(nodes: LayoutNode[]): Set<number> {
  const ids = new Set<number>()
  for (const node of nodes) {
    if (node.type === 'monitor') ids.add((node as MonitorNode).monitorId)
    else if (node.type === 'group') {
      for (const id of collectLayoutMonitorIds((node as GroupNode).children)) ids.add(id)
    }
  }
  return ids
}

function hasIncidentsBlock(nodes: LayoutNode[]): boolean {
  return nodes.some((node) => node.type === 'incidents')
}

export default function App() {
  const qc = useQueryClient()
  const [savedDarkMode, toggleDark] = useDarkMode()
  const previewMode = new URLSearchParams(window.location.search).get('branding-preview') === '1'
  const [brandingPreview, setBrandingPreview] = useState<Branding | null>(null)
  const [eventsTab, setEventsTab] = useState<'active' | 'history'>('active')
  const { t, locale } = useLocale()
  const [showSubscribe, setShowSubscribe] = useState(false)
  const [subscriptionLink, setSubscriptionLink] = useState(() => (previewMode ? null : readSubscriptionLink()))
  const { data: subscriptionOptions, isError: subscriptionOptionsFailed } = useSubscriptionOptions()
  const rssEnabled = !!subscriptionOptions?.methods.includes('rss')
  const subscribable = (subscriptionOptions?.methods.length ?? 0) > 0

  useEffect(() => {
    if (subscriptionLink) clearSubscriptionLink()
  }, [subscriptionLink])

  useEffect(() => {
    if (!rssEnabled) return
    const link = document.createElement('link')
    link.rel = 'alternate'
    link.type = 'application/rss+xml'
    link.title = t('page.feedTitle')
    link.href = FEED_URL
    document.head.appendChild(link)
    return () => link.remove()
  }, [rssEnabled, t])

  useEffect(() => {
    if (!previewMode || window.parent === window) return
    const receivePreview = (event: MessageEvent) => {
      if (event.source !== window.parent) return
      const isLocalAdmin = window.location.port === '5174' && /^https?:\/\/(localhost|127\.0\.0\.1):5173$/.test(event.origin)
      if (event.origin !== window.location.origin && !isLocalAdmin) return
      const data = event.data as { type?: string; branding?: Branding }
      if (data.type !== 'bsp:branding-preview' || !data.branding || typeof data.branding.siteName !== 'string') return
      setBrandingPreview(data.branding)
    }
    window.addEventListener('message', receivePreview)
    window.parent.postMessage({ type: 'bsp:branding-preview-ready' }, '*')
    return () => window.removeEventListener('message', receivePreview)
  }, [previewMode])

  const handleIncidentChange = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['public-status'] })
    qc.invalidateQueries({ queryKey: ['public-incidents'] })
  }, [qc])

  const statusMap = useSSE(handleIncidentChange)

  const statusQuery = useQuery<PublicStatus>({
    queryKey: ['public-status'],
    // Revalidate instead of reusing the browser's short-lived copy, so an SSE-triggered refetch
    // really picks up the change it was notified about.
    queryFn: () => getJSON<PublicStatus>('/api/v1/public/status', { cache: 'no-cache' }),
    refetchInterval: 5 * 60_000,
  })
  const status = statusQuery.data

  const layoutQuery = useQuery<PublicLayout>({
    queryKey: ['public-layout'],
    queryFn: () => getJSON<PublicLayout>('/api/v1/public/layout'),
    // Keep retrying while the hero says "retrying…" after a failed load.
    refetchInterval: (query) => (query.state.status === 'error' ? 30_000 : false),
  })
  const layoutData = layoutQuery.data

  const { data: incidents = [] } = useQuery<Incident[]>({
    queryKey: ['public-incidents'],
    queryFn: () => getJSON<Incident[]>('/api/v1/public/incidents?limit=10'),
  })

  const branding = brandingPreview ?? layoutData?.branding ?? status?.branding
  const tree = layoutData?.tree
  const monitors = status?.monitors ?? EMPTY_MONITORS
  const activeIncidents = status?.activeIncidents ?? []
  const activeMaintenanceWindows = status?.activeMaintenanceWindows ?? EMPTY_MAINTENANCE_WINDOWS
  const monitorDependencies = status?.monitorDependencies ?? EMPTY_MONITOR_DEPENDENCIES

  // dependencyMap: monitorId -> array of IDs it depends on
  const dependencyMap = useMemo(() => {
    const map: Record<number, number[]> = {}
    for (const dep of monitorDependencies) {
      if (!map[dep.dependentId]) map[dep.dependentId] = []
      map[dep.dependentId]!.push(dep.dependsOnId)
    }
    return map
  }, [monitorDependencies])

  const liveMonitors = monitors.map((m) => ({
    ...m,
    currentStatus: applyIncidentStatus(statusMap[m.id]?.status ?? m.currentStatus, m.id, activeIncidents),
  }))

  const layoutMonitorIds = tree && tree.children.length > 0 ? collectLayoutMonitorIds(tree.children) : null

  // Build a set of monitor IDs currently in maintenance
  const maintenanceMonitorIds = useMemo(() => {
    const set = new Set<number>()
    for (const win of activeMaintenanceWindows) {
      if (win.monitorIds.length === 0) {
        // All monitors in maintenance
        monitors.forEach((m) => set.add(m.id))
      } else {
        win.monitorIds.forEach((id) => set.add(id))
      }
    }
    return set
  }, [activeMaintenanceWindows, monitors])
  const visibleMonitors = layoutMonitorIds ? liveMonitors.filter((m) => layoutMonitorIds.has(m.id)) : []
  const layoutHasIncidents = tree ? hasIncidentsBlock(tree.children) : false

  const brandingEnabled = !!(branding?.enabled)
  // Layout options rather than colours, so they apply with or without custom branding. They wait
  // for the branding to arrive, so a section the admin turned off never flashes in on load.
  const brandingKnown = brandingPreview !== null || layoutData !== undefined || status !== undefined
    || (statusQuery.isError && layoutQuery.isError)
  const showHero = brandingKnown && branding?.showHero !== 0
  const showFooter = brandingKnown && branding?.showFooter !== 0
  const showProjectLink = brandingKnown && branding?.showProjectLink !== 0
  const isDark = brandingEnabled ? false : savedDarkMode

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
  }, [isDark])

  // Until both the status and the layout are in, nothing is known, so never claim "all operational" early.
  const loadFailed = (statusQuery.isError && !status) || (layoutQuery.isError && !layoutData)
  const loading = !loadFailed && (!status || !layoutData)
  const allUp = visibleMonitors.every((m) => m.currentStatus === 'up' || m.currentStatus === 'pending')
  const allDown = visibleMonitors.length > 0 && visibleMonitors.every((m) => m.currentStatus === 'down' || m.currentStatus === 'affected')
  const someDown = !allDown && visibleMonitors.some((m) => m.currentStatus === 'down' || m.currentStatus === 'affected')
  const anyDegraded = visibleMonitors.some((m) => m.currentStatus === 'degraded')
  const hasActiveIncidents = layoutHasIncidents && activeIncidents.length > 0

  const overallState = loadFailed
    ? 'error'
    : loading
    ? 'loading'
    : allDown
    ? 'down'
    : hasActiveIncidents
    ? 'incidents'
    : someDown
    ? 'partial'
    : anyDegraded
    ? 'degraded'
    : visibleMonitors.length === 0
    ? 'empty'
    : allUp
    ? 'up'
    : 'loading'

  const overallStatus = {
    error: t('overall.loadError'),
    loading: t('overall.checking'),
    down: t('overall.majorOutage'),
    incidents: t('overall.incidentsInProgress'),
    partial: t('overall.partialOutage'),
    degraded: t('overall.partialDegradation'),
    empty: t('overall.noServices'),
    up: t('overall.allOperational'),
  }[overallState]

  // Custom branding overrides these variables, so no separate branded colours are needed.
  const overallColor = {
    error: 'var(--m3-secondary)',
    loading: 'var(--m3-secondary)',
    down: 'var(--bsp-down)',
    incidents: 'var(--bsp-degraded)',
    partial: 'var(--bsp-partial)',
    degraded: 'var(--bsp-degraded)',
    empty: 'var(--m3-secondary)',
    up: 'var(--bsp-up)',
  }[overallState]
  const overallSettled = overallState !== 'error' && overallState !== 'loading'

  const resolvedIncidents = incidents.filter((i) => i.status === 'resolved')

  const cssVars: React.CSSProperties = brandingEnabled
    ? resolveBrandingCssVariables(branding!) as React.CSSProperties
    : {}

  const siteName = branding?.siteName || t('page.defaultTitle')
  const imageLogoUrl = resolveBrandingLogoUrl(branding, isDark, brandingEnabled)
  const customCss = resolveBrandingCustomCss(branding)
  document.title = siteName

  return (
    <div className="bsp-page flex flex-col" style={{ ...cssVars, background: 'var(--bsp-bg)', minHeight: '100vh' }}>
      {customCss && <style>{customCss}</style>}

      {/* ── Top Navigation ── */}
      <header className="bsp-header" style={{ background: 'var(--bsp-bg)', position: 'sticky', top: 0, zIndex: 50 }}>
        <nav className="bsp-navigation flex justify-between items-center gap-3 px-4 md:px-8 py-4 md:py-5 max-w-[1440px] mx-auto">
          {/* Logo */}
          <div className="flex items-center">
            {branding?.logoType === 'text' && branding.logoText ? (
              <span
                className="bsp-site-name font-headline font-extrabold"
                style={{ fontSize: '22px', color: 'var(--m3-on-surface)', letterSpacing: '-0.01em' }}
              >
                {branding.logoText}
              </span>
            ) : imageLogoUrl ? (
              <img src={imageLogoUrl} alt={siteName} style={{ height: '40px', maxWidth: '200px', objectFit: 'contain' }} />
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
            {subscribable && !previewMode && (
              <button
                onClick={() => setShowSubscribe(true)}
                className="bsp-subscribe-button bsp-action inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold transition-all active:scale-95"
                style={{ background: 'var(--bsp-action-bg)', color: 'var(--bsp-action-fg)' }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>notifications</span>
                {t('subscribe.button')}
              </button>
            )}
            <LanguageSwitcher />
            {!brandingEnabled && (
              <button
                type="button"
                onClick={toggleDark}
                className="bsp-ghost p-2 rounded-full transition-all active:scale-95"
                style={{ color: 'var(--m3-secondary)' }}
                aria-label={t('page.toggleDarkMode')}
              >
                <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '22px' }}>
                  {isDark ? 'light_mode' : 'dark_mode'}
                </span>
              </button>
            )}
          </div>
        </nav>
      </header>

      {/* ── Maintenance Banner ── */}
      {activeMaintenanceWindows.length > 0 && (
        <div className="bsp-maintenance-banner" style={{ background: 'var(--bsp-maintenance-bg)', borderBottom: '1px solid var(--bsp-maintenance-border)' }}>
          <div className="max-w-[1440px] mx-auto px-4 md:px-8 py-3 flex flex-col gap-2">
            {activeMaintenanceWindows.map((win) => (
              <div key={win.id} className="flex items-start gap-3">
                <span className="material-symbols-outlined flex-shrink-0 mt-0.5" style={{ fontSize: '18px', color: 'var(--bsp-maintenance-text)' }}>construction</span>
                <div>
                  <span className="font-semibold text-sm" style={{ color: 'var(--bsp-maintenance-text)' }}>{win.name}</span>
                  {win.description && (
                    <span className="text-sm ml-2" style={{ color: 'var(--bsp-maintenance-muted)' }}>{win.description}</span>
                  )}
                  <span className="text-xs ml-2" style={{ color: 'var(--bsp-maintenance-muted)', opacity: 0.8 }}>
                    {t('page.maintenanceUntil', { date: new Date(win.endsAt).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Grows to fill the viewport so the footer sits at the bottom even on a short page. */}
      <main className="bsp-content flex-1 flex flex-col w-full max-w-[1440px] mx-auto px-4 md:px-8" id="status">

        {/* ── Hero ── (Branding can hide it to leave more room for monitors; the heading stays for screen readers) */}
        {!showHero && <h1 className="sr-only">{overallStatus}</h1>}
        {showHero && <section className="py-10 md:py-20 flex flex-col items-center text-center fade-up" style={{ animationDelay: '0ms' }}>
          <div
            className="bsp-status-banner inline-flex items-center gap-3 px-4 py-2 rounded-full mb-6 md:mb-8"
            style={{ background: 'var(--m3-surface-container-high)' }}
          >
            <span
              className={`w-2.5 h-2.5 rounded-full${overallState === 'error' || overallState === 'empty' ? '' : ' animate-pulse'}`}
              style={{ background: overallColor }}
            />
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

          {overallSettled && visibleMonitors.length > 0 && (
            <p className="text-lg md:text-xl max-w-2xl mx-auto leading-relaxed" style={{ color: 'var(--m3-secondary)' }}>
              {t('page.monitoredLine', { n: visibleMonitors.length })}
              {layoutHasIncidents && activeIncidents.length > 0 && ` ${t('page.incidentLine', { n: activeIncidents.length })}`}
            </p>
          )}
        </section>}

        {/* ── Main content — always from PageRenderer when tree exists ── */}
        {tree && tree.children.length > 0 ? (
          <section className={`mb-32 fade-up${showHero ? '' : ' pt-8 md:pt-12'}`} style={{ animationDelay: '80ms' }}>
            <PageRenderer
              tree={tree}
              monitors={liveMonitors}
              statusMap={statusMap}
              activeIncidents={activeIncidents}
              allIncidents={incidents}
              maintenanceMonitorIds={maintenanceMonitorIds}
              dependencyMap={dependencyMap}
            />
          </section>
        ) : tree !== undefined ? (
          /* Layout loaded but empty — prompt to configure */
          <section className="mb-32 fade-up flex flex-col items-center text-center py-12" style={{ animationDelay: '80ms' }}>
            <span className="material-symbols-outlined mb-4" style={{ fontSize: '48px', color: 'var(--m3-outline)' }}>dashboard_customize</span>
            <p className="text-lg font-semibold mb-2" style={{ color: 'var(--m3-on-surface)' }}>{t('page.notConfigured')}</p>
            <p className="text-sm" style={{ color: 'var(--m3-secondary)' }}>{t('page.notConfiguredHint')}</p>
          </section>
        ) : null}

        {/* ── Events Section (shown only when layout is not yet configured) ── */}
        {tree === undefined && (activeIncidents.length > 0 || resolvedIncidents.length > 0) && (
          <section className="bsp-incidents-section mb-32 fade-up" id="events" style={{ animationDelay: '160ms' }}>
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
                    <span className="material-symbols-outlined block mb-3" style={{ fontSize: '32px', color: 'var(--bsp-up)' }}>
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

        {/* ── Footer ── (pushed to the bottom of the viewport on a short page) */}
        {showFooter && <footer
          className={`bsp-footer text-center mt-auto pt-12 ${showProjectLink ? 'pb-4' : 'pb-12'}`}
          style={{
            color: 'var(--m3-secondary)',
            borderTop: '0',
          }}
        >
          {branding?.logoType === 'text' && branding.logoText ? (
            <span className="bsp-site-name font-headline font-extrabold block mb-4" style={{ fontSize: '22px' }}>{branding.logoText}</span>
          ) : (
            <img src={imageLogoUrl ?? (isDark ? '/logo_dark.png' : '/logo_light.png')} alt={siteName} style={{ height: '80px', maxWidth: '260px', objectFit: 'contain', margin: '0 auto 16px', opacity: 0.75 }} />
          )}
          <p className="text-xs uppercase tracking-widest">{siteName}</p>
        </footer>}
      </main>

      {/* Page-wide, so it sits in the bottom-right corner of the window, not of the content column. */}
      {showProjectLink && (
        <div className="flex justify-end px-4 md:px-8 pb-4 pt-2">
          <a
            href="https://github.com/BElluu/BetterStatusPage"
            target="_blank"
            rel="noopener noreferrer"
            className="bsp-project-link inline-flex items-center gap-1.5 text-[11px] rounded"
          >
            <svg aria-hidden="true" width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
              <rect x="0.5" y="6" width="3" height="5.5" rx="1" />
              <rect x="4.5" y="3.5" width="3" height="8" rx="1" />
              <rect x="8.5" y="0.5" width="3" height="11" rx="1" />
            </svg>
            <span className="font-semibold">BetterStatusPage</span>
          </a>
        </div>
      )}

      {showSubscribe && subscriptionOptions && subscribable && (
        <SubscribeDialog options={subscriptionOptions} onClose={() => setShowSubscribe(false)} />
      )}
      {subscriptionLink && (
        <SubscriptionLinkDialog link={subscriptionLink} options={subscriptionOptions} optionsFailed={subscriptionOptionsFailed} onClose={() => setSubscriptionLink(null)} />
      )}
    </div>
  )
}

/* ── History Row (resolved incidents) ────────────────────────────── */
function HistoryRow({ incident }: { incident: Incident }) {
  const { t, locale } = useLocale()
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
          {new Date(incident.startedAt).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
      </div>
      <div>
        <h4 className="font-bold font-sans text-sm" style={{ color: 'var(--m3-on-surface)' }}>{incident.title}</h4>
        <p className="text-xs mt-0.5" style={{ color: 'var(--m3-secondary)' }}>{t('incident.impactLine', { impact: t(`incident.impact.${incident.impact}`) })}</p>
      </div>
      <div className="text-right">
        <span
          className="px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider"
          style={{ background: 'color-mix(in srgb, var(--bsp-up) 12%, transparent)', color: 'var(--bsp-up-text)' }}
        >
          {t('incident.resolved')}
        </span>
      </div>
    </div>
  )
}
