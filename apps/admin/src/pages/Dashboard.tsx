import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api, getCurrentUser } from '../api/client'
import type { MonitorListItem, Incident, MaintenanceWindow, MonitorStatus } from '@bsp/shared'
import { ActivityBadges, MonitorStatusBadge, effectiveStatus } from '../components/monitors/StatusBadge'
import { Sparkline } from '../components/monitors/Sparkline'
import { EmptyState, ErrorState, LoadingState, PageContainer, PageHeader } from '@better-forge/ui'
import { formatDayMonth, formatDateTime } from '@better-forge/ui'
import { failingFor, formatPercent, isSlower, monitorEndpoint, monitorSeverity } from '../components/monitors/monitorDisplay'
import { formatAgo, useNow } from '../relativeTime'

/** Shared surface for the summary card and the lists, matching the component cards. */
const TILE_STYLE = { background: 'var(--m3-surface-container-lowest)' } as const
const LIST_STYLE = { ...TILE_STYLE, border: '1px solid var(--m3-outline-variant)' } as const

/** Operational monitors shown before the list is cut off with a link to the full one. */
const REST_LIMIT = 8

const STATUS_DOT: Record<MonitorStatus, string> = {
  up: 'var(--m3-up-bar)', down: 'var(--m3-down)', degraded: 'var(--m3-degraded-bar)', affected: 'var(--m3-degraded-bar)', pending: 'var(--m3-outline)',
}

const IMPACT_TONE = {
  minor: { color: 'var(--m3-degraded)', bg: 'var(--m3-degraded-bg)' },
  major: { color: 'var(--m3-partial)', bg: 'var(--m3-partial-bg)' },
  critical: { color: 'var(--m3-down)', bg: 'var(--m3-down-bg)' },
} as const

function MonitorRow({ monitor, now }: { monitor: MonitorListItem; now: number }) {
  const status = effectiveStatus(monitor)
  const avg = monitor.health.avgResponseMs
  return (
    <Link
      to={`/admin/monitors/${monitor.id}`}
      className={`grid grid-cols-[10px_minmax(0,1fr)_auto] sm:grid-cols-[10px_minmax(0,1fr)_auto_64px_72px] items-center gap-3 px-4 py-2.5 focus-ring ${status === 'down' ? 'bg-[var(--m3-down-bg)] hover:bg-[color-mix(in_srgb,var(--m3-down)_12%,var(--m3-down-bg))]' : 'hover:bg-surface-container'}`}
    >
      <span className="w-2 h-2 rounded-full" aria-hidden="true" style={{ background: STATUS_DOT[status] }} />
      <div className="min-w-0">
        <h4 className="text-sm font-bold truncate" style={{ color: 'var(--m3-on-surface)' }} title={monitor.name}>{monitor.name}</h4>
        <p className="text-xs font-label truncate" style={{ color: 'var(--m3-on-surface-variant)' }} title={monitorEndpoint(monitor)}>{monitorEndpoint(monitor)}</p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {status === 'up' && isSlower(monitor) ? null : status === 'up' && avg !== null ? (
          <span className="inline-flex items-center text-xs font-semibold px-2.5 py-0.5 rounded-full" style={{ background: 'var(--m3-up-bg)', color: 'var(--m3-up)' }}>
            <span className="sr-only">Operational, </span>{Math.round(avg)} ms
          </span>
        ) : (
          <MonitorStatusBadge monitor={monitor} detail={failingFor(monitor, now)} />
        )}
        <ActivityBadges activity={monitor.activity} slower={isSlower(monitor)} slowerRatio={monitor.health.latencyRatio} />
      </div>
      <span className="hidden sm:block">
        <Sparkline values={monitor.health.responseTrend} status={status} label={`Response time, last 24 hours${avg !== null ? `, average ${Math.round(avg)} ms` : ''}`} />
      </span>
      <span className="hidden sm:block text-right text-xs" style={{ color: 'var(--m3-secondary)' }} title={monitor.lastCheckedAt ? formatDateTime(monitor.lastCheckedAt) : undefined}>
        {monitor.lastCheckedAt ? formatAgo(monitor.lastCheckedAt, now) : '—'}
      </span>
    </Link>
  )
}

function GroupHeading({ children, count, hint, alert = false }: { children: React.ReactNode; count: number; hint: string; alert?: boolean }) {
  return (
    <h3
      className="flex justify-between px-4 py-2 font-label text-[10px] uppercase tracking-widest"
      style={alert ? { background: 'var(--m3-down-bg)', color: 'var(--m3-down)' } : { background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)' }}
    >
      <span>{children} · {count}</span><span>{hint}</span>
    </h3>
  )
}

function RailCard({ title, count, to, children }: { title: string; count?: number | undefined; to?: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="rounded-xl p-4" style={LIST_STYLE}>
      <div className="flex justify-between items-baseline mb-3">
        <h3 className="font-label text-[10px] uppercase tracking-widest" style={{ color: 'var(--m3-secondary)' }}>{title}{count !== undefined && ` · ${count}`}</h3>
        {to && <Link to={to} className="text-xs font-semibold underline underline-offset-2" style={{ color: 'var(--m3-on-surface)' }}>View all</Link>}
      </div>
      <div className="divide-y divide-outline-variant">{children}</div>
    </section>
  )
}

/** The mean of what the monitors report, ignoring those without a value. */
function mean(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null)
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) / present.length : null
}

export default function DashboardPage() {
  const now = useNow()
  const monitorsQuery = useQuery<MonitorListItem[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
    refetchInterval: 15_000,
  })
  const monitors = monitorsQuery.data ?? []

  // Only administrators can act on an update, and only they may ask for it.
  const updateQuery = useQuery<{ update: { version: string; url: string } | null }>({
    queryKey: ['update-available'],
    queryFn: () => api.get('/admin/system-health/update'),
    enabled: getCurrentUser()?.role === 'admin',
    staleTime: 10 * 60_000,
  })
  const update = updateQuery.data?.update ?? null

  const incidentsQuery = useQuery<Incident[]>({
    queryKey: ['incidents'],
    queryFn: () => api.get('/admin/incidents'),
  })
  const incidents = incidentsQuery.data ?? []

  const maintenanceQuery = useQuery<MaintenanceWindow[]>({
    queryKey: ['maintenance'],
    queryFn: () => api.get('/admin/maintenance'),
  })

  const statuses = monitors.map(effectiveStatus)
  const up       = statuses.filter((s) => s === 'up').length
  const down     = statuses.filter((s) => s === 'down').length
  const degraded = statuses.filter((s) => s === 'degraded').length
  const uptime   = mean(monitors.map((m) => m.health.uptime24h))
  const avgMs    = mean(monitors.map((m) => m.health.avgResponseMs))

  const activeIncidents = incidents.filter((i) => i.status !== 'resolved')
  const recentActivity  = incidents.slice(0, 5)
  const upcomingMaintenance = (maintenanceQuery.data ?? [])
    .filter((w) => w.occurrence.endsAt > now)
    .sort((a, b) => a.occurrence.startsAt - b.occurrence.startsAt)
    .slice(0, 3)

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

  // Needs attention first, worst first; the rest keeps the order the monitors come in.
  const sorted = [...monitors].sort((a, b) => monitorSeverity(a) - monitorSeverity(b))
  const needsAttention = sorted.filter((m) => { const s = effectiveStatus(m); return (s !== 'up' && s !== 'pending') || isSlower(m) })
  const rest = sorted.filter((m) => !needsAttention.includes(m))

  const header = (
    <PageHeader
      title="Dashboard"
      subtitle="Overview of your monitoring infrastructure."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {update && (
            <a
              href={update.url}
              target="_blank"
              rel="noopener"
              className="flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-medium"
              style={{ color: 'var(--m3-secondary)', border: '1px solid var(--m3-outline-variant)' }}
            >
              <span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: '16px' }}>system_update_alt</span>
              Version {update.version} is available
            </a>
          )}
          <div
            className="flex items-center px-4 py-2 rounded-full text-sm font-medium"
            style={{ background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)', color: 'var(--m3-on-surface-variant)' }}
          >
            {monitorsQuery.dataUpdatedAt > 0 ? `Updated ${formatAgo(monitorsQuery.dataUpdatedAt, now)}` : 'Updating…'}
          </div>
          <div>
            <button
              type="button"
              onClick={() => void monitorsQuery.refetch()}
              disabled={monitorsQuery.isFetching}
              aria-label="Refresh now"
              title="Refresh now"
              className="btn btn-secondary px-2"
            >
              <span className={`material-symbols-outlined ${monitorsQuery.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" style={{ fontSize: '18px' }}>refresh</span>
            </button>
          </div>
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
    <PageContainer className="max-w-[1440px] mx-auto">
      {header}

      {/* One status strip: the state, how it splits, and the numbers over the last 24 hours. */}
      <section className="rounded-xl p-6 grid grid-cols-1 md:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))] gap-6 items-center" style={TILE_STYLE}>
        <div>
          <span className="font-label text-xs uppercase tracking-widest block mb-2" style={{ color: 'var(--m3-secondary)' }}>
            Current Status
          </span>
          <h2 className="font-headline text-3xl font-bold mb-1" style={{ color: 'var(--m3-on-surface)' }}>
            {globalStatus}
          </h2>
          <p style={{ color: 'var(--m3-on-surface-variant)' }}>
            {monitors.length} monitor{monitors.length !== 1 ? 's' : ''} tracked · {up} operational
            {down > 0 && ` · ${down} down`}{degraded > 0 && ` · ${degraded} degraded`}
          </p>
          {monitors.length > 0 && (
            <div className="mt-5">
              <div className="flex rounded-full overflow-hidden h-2.5 mb-3" style={{ background: 'var(--m3-surface-container)' }}>
                {up > 0 && <div style={{ width: `${(up / monitors.length) * 100}%`, background: 'var(--m3-up-bar)' }} />}
                {degraded > 0 && <div style={{ width: `${(degraded / monitors.length) * 100}%`, background: 'var(--m3-degraded-bar)' }} />}
                {down > 0 && <div style={{ width: `${(down / monitors.length) * 100}%`, background: 'var(--m3-down)' }} />}
              </div>
              <div className="flex flex-wrap gap-4 text-xs font-medium" style={{ color: 'var(--m3-on-surface-variant)' }}>
                {up > 0 && <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full inline-block" style={{ background: 'var(--m3-up-bar)' }} />{up} operational</span>}
                {degraded > 0 && <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full inline-block" style={{ background: 'var(--m3-degraded-bar)' }} />{degraded} degraded</span>}
                {down > 0 && <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full inline-block" style={{ background: 'var(--m3-down)' }} />{down} down</span>}
              </div>
            </div>
          )}
        </div>

        {[
          { label: 'operational', value: monitors.length > 0 ? String(up) : '—', unit: monitors.length > 0 ? ` / ${monitors.length}` : '' },
          { label: 'uptime, 24 h', value: uptime !== null ? formatPercent(uptime) : '—', unit: '' },
          { label: 'avg response', value: avgMs !== null ? String(Math.round(avgMs)) : '—', unit: avgMs !== null ? ' ms' : '' },
        ].map((figure) => (
          <dl key={figure.label}>
            <dd className="font-headline text-3xl font-extrabold tabular-nums" style={{ color: 'var(--m3-on-surface)' }}>
              {figure.value}<span className="text-sm font-medium" style={{ color: 'var(--m3-secondary)' }}>{figure.unit}</span>
            </dd>
            <dt className="text-xs mt-0.5" style={{ color: 'var(--m3-secondary)' }}>{figure.label}</dt>
          </dl>
        ))}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] gap-6 items-start">
        {/* System Components */}
        <section>
          <div className="flex justify-between items-end mb-4">
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
              description="Add your first monitor to start tracking uptime and show it on your status page."
              action={<Link to="/admin/monitors" className="btn btn-primary">Add your first monitor</Link>}
            />
          ) : (
            <div className="rounded-xl overflow-hidden" style={LIST_STYLE}>
              {needsAttention.length > 0 && (
                <>
                  <GroupHeading count={needsAttention.length} hint="worst first" alert>Needs attention</GroupHeading>
                  <div className="divide-y divide-outline-variant">
                    {needsAttention.map((m) => <MonitorRow key={m.id} monitor={m} now={now} />)}
                  </div>
                </>
              )}
              {rest.length > 0 && (
                <>
                  <GroupHeading count={rest.length} hint="response · 24 h">{needsAttention.length > 0 ? 'Operational' : 'All monitors'}</GroupHeading>
                  <div className="divide-y divide-outline-variant">
                    {rest.slice(0, REST_LIMIT).map((m) => <MonitorRow key={m.id} monitor={m} now={now} />)}
                    {rest.length > REST_LIMIT && (
                      <Link to="/admin/monitors" className="block px-4 py-2.5 text-sm hover:bg-surface-container focus-ring" style={{ color: 'var(--m3-on-surface-variant)' }}>
                        + {rest.length - REST_LIMIT} more · <span className="font-semibold underline underline-offset-2" style={{ color: 'var(--m3-on-surface)' }}>Show all monitors</span>
                      </Link>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </section>

        <div className="flex flex-col gap-4">
          <RailCard title="Open incidents" count={incidentsQuery.isSuccess ? activeIncidents.length : undefined} to="/admin/incidents">
            {incidentsQuery.isPending && <p className="py-2 text-sm" style={{ color: 'var(--m3-secondary)' }}>Loading incidents…</p>}
            {incidentsQuery.isError && <p className="py-2 text-sm" style={{ color: 'var(--m3-secondary)' }}>Couldn't load incidents.</p>}
            {incidentsQuery.isSuccess && activeIncidents.length === 0 && <p className="py-2 text-sm" style={{ color: 'var(--m3-secondary)' }}>No active issues.</p>}
            {activeIncidents.slice(0, 5).map((incident) => (
              <div key={incident.id} className="py-2.5 first:pt-0">
                <span className="block text-sm font-bold" style={{ color: 'var(--m3-on-surface)' }}>{incident.title}</span>
                <span className="flex flex-wrap items-center gap-2 mt-1 text-xs" style={{ color: 'var(--m3-on-surface-variant)' }}>
                  <span className="px-2 py-0.5 rounded-full font-semibold capitalize" style={{ color: IMPACT_TONE[incident.impact].color, background: IMPACT_TONE[incident.impact].bg }}>{incident.impact}</span>
                  <span className="capitalize">{incident.status}</span> · started {formatAgo(incident.startedAt, now)}
                </span>
              </div>
            ))}
          </RailCard>

            <RailCard title="Upcoming maintenance" to="/admin/maintenance">
              {maintenanceQuery.isSuccess && upcomingMaintenance.length === 0 && <p className="py-2 text-sm" style={{ color: 'var(--m3-secondary)' }}>No maintenance planned.</p>}
              {upcomingMaintenance.map((w) => {
                const running = w.occurrence.startsAt <= now
                return (
                  <div key={w.id} className="py-2.5 first:pt-0">
                    <span className="block text-sm font-bold" style={{ color: 'var(--m3-on-surface)' }}>{w.name}</span>
                    <span className="block mt-1 text-xs" style={{ color: 'var(--m3-on-surface-variant)' }}>
                      {running ? `In progress until ${formatDateTime(w.occurrence.endsAt)}` : formatDateTime(w.occurrence.startsAt)}
                      {' · '}{w.monitorIds.length === 0 ? 'All monitors' : `${w.monitorIds.length} monitor${w.monitorIds.length !== 1 ? 's' : ''}`}
                    </span>
                  </div>
                )
              })}
            </RailCard>

          {recentActivity.length > 0 && (
            <RailCard title="Recent Activity">
              {recentActivity.map((incident) => {
                const isResolved = incident.status === 'resolved'
                const dotColor = isResolved ? 'var(--m3-up-bar)' : incident.impact === 'critical' || incident.impact === 'major' ? 'var(--m3-down)' : 'var(--m3-degraded-bar)'
                return (
                  <div key={incident.id} className="flex gap-3 py-2.5 first:pt-0">
                    <span className="w-14 shrink-0 pt-0.5 font-label text-[10px] uppercase tracking-wide" style={{ color: 'var(--m3-secondary)' }}>{formatDayMonth(incident.startedAt)}</span>
                    <div className="min-w-0">
                      <h4 className="flex items-center gap-2 text-sm font-bold" style={{ color: 'var(--m3-on-surface)' }}>
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" aria-hidden="true" style={{ background: dotColor }} />
                        <span className="truncate">{incident.title}</span>
                      </h4>
                      <p className="text-xs" style={{ color: 'var(--m3-on-surface-variant)' }}>
                        <span className="capitalize">{incident.impact}</span> impact · {incident.status}
                      </p>
                    </div>
                  </div>
                )
              })}
            </RailCard>
          )}
        </div>
      </div>
    </PageContainer>
  )
}
