import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { Monitor, Incident } from '@bsp/shared'
import { StatusBadge } from '../components/monitors/StatusBadge'
import { useDarkMode } from '../hooks/useDarkMode'
import { EmptyState, ErrorState, LoadingState, PageContainer, PageHeader } from '../components/ui'

/** Shared surface for the summary tiles, matching the component cards below. */
const TILE_STYLE = { background: 'var(--m3-surface-container-lowest)' } as const

export default function DashboardPage() {
  const [isDark] = useDarkMode()
  const monitorsQuery = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
    refetchInterval: 15_000,
  })
  const monitors = monitorsQuery.data ?? []

  const incidentsQuery = useQuery<Incident[]>({
    queryKey: ['incidents'],
    queryFn: () => api.get('/admin/incidents'),
  })
  const incidents = incidentsQuery.data ?? []

  const up       = monitors.filter((m) => m.currentStatus === 'up').length
  const down     = monitors.filter((m) => m.currentStatus === 'down').length
  const degraded = monitors.filter((m) => m.currentStatus === 'degraded').length

  const activeIncidents = incidents.filter((i) => i.status !== 'resolved')
  const recentActivity  = incidents.slice(0, 5)

  const allDown = down > 0 && down === monitors.length
  const globalStatus = allDown
    ? 'Major Outage Detected'
    : down > 0
    ? 'Partial Outage'
    : degraded > 0
    ? 'Partial Degradation'
    : monitors.length === 0
    ? 'No Monitors Yet'
    : 'All Systems Operational'

  const header = (
    <PageHeader
      title="Dashboard"
      subtitle="Overview of your monitoring infrastructure."
      actions={
        <div
          className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium"
          style={{ background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)' }}
        >
          <span className="w-2 h-2 rounded-full animate-pulse" aria-hidden="true" style={{ background: 'var(--m3-up-bar)' }} />
          <span style={{ color: 'var(--m3-on-surface-variant)' }}>Live Metrics</span>
        </div>
      }
    />
  )

  if (monitorsQuery.isPending || monitorsQuery.isError) {
    return (
      <PageContainer className="max-w-[1440px] mx-auto">
        {header}
        {monitorsQuery.isPending
          ? <LoadingState label="Loading monitors…" />
          : <ErrorState message="Couldn't load monitors." onRetry={() => void monitorsQuery.refetch()} />}
      </PageContainer>
    )
  }

  return (
    <PageContainer className="max-w-[1440px] mx-auto pb-24">
      {header}

      {/* Status Bento Grid */}
      <section className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {/* Global Status — span 2 */}
        <div
          className="md:col-span-2 p-8 rounded-xl flex flex-col justify-between"
          style={TILE_STYLE}
        >
          <div>
            <span className="font-label text-xs uppercase tracking-widest block mb-4" style={{ color: 'var(--m3-secondary)' }}>
              Current Status
            </span>
            <h2 className="font-headline text-3xl font-bold mb-2" style={{ color: 'var(--m3-on-surface)' }}>
              {globalStatus}
            </h2>
            <p className="max-w-md" style={{ color: 'var(--m3-on-surface-variant)' }}>
              {monitors.length} monitor{monitors.length !== 1 ? 's' : ''} tracked · {up} operational
              {down > 0 && ` · ${down} down`}{degraded > 0 && ` · ${degraded} degraded`}
            </p>
          </div>
          {/* Monitor status breakdown */}
          {monitors.length > 0 && (
            <div className="mt-8">
              <div className="flex rounded-full overflow-hidden h-2.5 mb-3">
                {up > 0 && (
                  <div style={{ width: `${(up / monitors.length) * 100}%`, background: 'var(--m3-up-bar)' }} />
                )}
                {degraded > 0 && (
                  <div style={{ width: `${(degraded / monitors.length) * 100}%`, background: 'var(--m3-degraded-bar)' }} />
                )}
                {down > 0 && (
                  <div style={{ width: `${(down / monitors.length) * 100}%`, background: 'var(--m3-down)' }} />
                )}
              </div>
              <div className="flex gap-4 text-xs font-medium" style={{ color: 'var(--m3-on-surface-variant)' }}>
                {up > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full inline-block" style={{ background: 'var(--m3-up-bar)' }} />
                    {up} operational
                  </span>
                )}
                {degraded > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full inline-block" style={{ background: 'var(--m3-degraded-bar)' }} />
                    {degraded} degraded
                  </span>
                )}
                {down > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full inline-block" style={{ background: 'var(--m3-down)' }} />
                    {down} down
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Active Incidents */}
        <div
          className="p-8 rounded-xl flex flex-col justify-between"
          style={{
            ...TILE_STYLE,
            ...(activeIncidents.length > 0 ? { background: 'var(--m3-error-container)' } : {}),
            color: activeIncidents.length > 0 ? 'var(--m3-on-error-container)' : 'var(--m3-on-surface)',
          }}
        >
          <span className="font-label text-xs uppercase tracking-widest" style={{ color: activeIncidents.length > 0 ? 'inherit' : 'var(--m3-secondary)' }}>Active Incidents</span>
          <div>
            <div className="text-5xl font-extrabold mb-2">{incidentsQuery.isSuccess ? activeIncidents.length : '—'}</div>
            <p className="text-sm opacity-80">
              {incidentsQuery.isPending
                ? 'Loading incidents…'
                : incidentsQuery.isError
                ? "Couldn't load incidents."
                : activeIncidents.length === 0
                ? 'No active issues.'
                : `${activeIncidents.length} incident${activeIncidents.length > 1 ? 's' : ''} in progress.`}
            </p>
          </div>
        </div>

        {/* Monitor Stats */}
        <div
          className="p-8 rounded-xl flex flex-col justify-between"
          style={TILE_STYLE}
        >
          <span className="font-label text-xs uppercase tracking-widest" style={{ color: 'var(--m3-secondary)' }}>
            Monitor Health
          </span>
          <div>
            <div className="text-5xl font-extrabold mb-2" style={{ color: 'var(--m3-on-surface)' }}>
              {monitors.length > 0 ? `${Math.round((up / monitors.length) * 100)}%` : '—'}
            </div>
            <div className="flex items-center gap-1 text-xs font-semibold" style={{ color: up === monitors.length && monitors.length > 0 ? 'var(--m3-up)' : 'var(--m3-secondary)' }}>
              <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '14px' }}>
                {up === monitors.length && monitors.length > 0 ? 'arrow_upward' : 'remove'}
              </span>
              {up} of {monitors.length} operational
            </div>
          </div>
        </div>
      </section>

      {/* System Components */}
      <section>
        <div className="flex justify-between items-end mb-6">
          <h2 className="font-headline text-xl font-bold" style={{ color: 'var(--m3-on-surface)' }}>
            System Components
          </h2>
          <Link to="/admin/monitors" className="btn btn-secondary rounded-full">
            Manage Monitors
          </Link>
        </div>

        {monitors.length === 0 ? (
          <EmptyState
            icon="radio_button_checked"
            title="No monitors yet"
            description="Add a monitor to start tracking uptime."
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {monitors.map((monitor) => {
              const dotColor = monitor.currentStatus === 'up'
                ? 'var(--m3-up-bar)'
                : monitor.currentStatus === 'down'
                ? 'var(--m3-down)'
                : monitor.currentStatus === 'degraded'
                ? 'var(--m3-degraded-bar)'
                : 'var(--m3-outline)'

              const endpoint = monitor.type === 'https'
                ? (monitor.config as { url: string }).url
                : monitor.type === 'ping'
                ? (monitor.config as { host: string }).host
                : monitor.type === 'dns'
                ? (monitor.config as { hostname: string }).hostname
                : `${monitor.type}`

              return (
                <div
                  key={monitor.id}
                  className="group p-6 rounded-xl flex items-center justify-between transition-all border border-transparent hover:border-outline-variant"
                  style={{ background: 'var(--m3-surface-container-lowest)' }}
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: dotColor }} />
                    <div className="min-w-0">
                      <h3 className="font-bold" style={{ color: 'var(--m3-on-surface)' }}>{monitor.name}</h3>
                      <p className="text-xs font-label truncate max-w-[260px]" style={{ color: 'var(--m3-on-surface-variant)' }}>
                        {endpoint}
                      </p>
                    </div>
                  </div>
                  <StatusBadge status={monitor.currentStatus} />
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Recent Activity — asymmetric layout */}
      {recentActivity.length > 0 && (
        <section
          className="grid grid-cols-1 md:grid-cols-3 gap-12 pt-10"
          style={{ borderTop: '1px solid var(--m3-outline-variant)' }}
        >
          <div>
            <h2 className="font-headline text-xl font-bold mb-4" style={{ color: 'var(--m3-on-surface)' }}>
              Recent Activity
            </h2>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--m3-on-surface-variant)' }}>
              Latest incident updates and status changes across your monitored services.
            </p>
          </div>
          <div className="md:col-span-2 space-y-8">
            {recentActivity.map((incident) => {
              const isResolved = incident.status === 'resolved'
              const dotColor = isResolved ? 'var(--m3-up-bar)' : incident.impact === 'critical' || incident.impact === 'major' ? 'var(--m3-down)' : 'var(--m3-degraded-bar)'
              return (
                <div key={incident.id} className="flex gap-8">
                  <div
                    className="font-label text-xs w-24 shrink-0 pt-1 uppercase tracking-wide"
                    style={{ color: 'var(--m3-secondary)' }}
                  >
                    {new Date(incident.startedAt).toLocaleDateString('en', { month: 'short', day: 'numeric' })}
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: dotColor }} />
                      <h3 className="font-bold text-sm" style={{ color: 'var(--m3-on-surface)' }}>
                        {incident.title}
                      </h3>
                    </div>
                    <p className="text-sm" style={{ color: 'var(--m3-on-surface-variant)' }}>
                      {incident.impact} impact · {incident.status}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Footer */}
      <footer className="py-10 text-center" style={{ color: 'var(--m3-secondary)' }}>
        <img src={isDark ? '/admin/logo_dark.png' : '/admin/logo_light.png'} alt="BetterStatusPage" style={{ height: '100px', objectFit: 'contain', margin: '0 auto 10px', opacity: 0.55 }} />
        <p className="text-xs uppercase tracking-widest">BetterStatusPage</p>
      </footer>
    </PageContainer>
  )
}
