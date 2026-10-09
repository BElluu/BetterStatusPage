import { useState, type ReactNode } from 'react'
import { formatClock, formatDate, formatDateTime, formatDayMonth } from '../lib/dateFormat'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { DEFAULT_UPTIME_THRESHOLDS, classifyUptimeDay } from '@bsp/shared'
import type { DnsConfig, DockerConfig, HttpsConfig, Monitor, MonitorStats, PingConfig, UptimeDayStatus } from '@bsp/shared'
import { StatusBadge } from '../components/monitors/StatusBadge'
import MonitorFormModal from '../components/monitors/MonitorFormModal'
import { MONITOR_TYPES } from '../components/monitors/monitorTypes'
import { ResponseTimeChart, formatMs, type ChartMetric } from '../components/monitors/ResponseTimeChart'
import { Alert, EmptyState, ErrorState, LoadingState, PageContainer, PageHeader, useToast } from '../components/ui'

const DAY_MS = 86_400_000
const RANGES = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
  { label: '90d', hours: 2160 },
] as const
const METRICS: Array<{ label: string; value: ChartMetric }> = [
  { label: 'Avg', value: 'avg' },
  { label: 'p95', value: 'p95' },
  { label: 'Max', value: 'max' },
]

const CARD = { background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }
const LABEL = 'font-mono text-[10px] uppercase tracking-widest'

const formatPct = (value: number | null) => (value === null ? '—' : `${value.toFixed(3)}%`)
const dateTime = (ms: number) => formatDateTime(ms)

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return '< 1 min'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours} h ${minutes % 60} min` : `${Math.round(hours / 24)} days`
}

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl p-4 md:p-5" style={CARD}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="font-headline font-semibold text-base" style={{ color: 'var(--m3-on-surface)' }}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

function Rows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl>
      {rows.map(([label, value], i) => (
        <div key={label} className="flex justify-between gap-3 py-2 text-sm" style={i > 0 ? { borderTop: '1px solid var(--m3-outline-variant)' } : undefined}>
          <dt style={{ color: 'var(--m3-secondary)' }}>{label}</dt>
          <dd className="font-semibold text-right min-w-0 break-words" style={{ color: 'var(--m3-on-surface)' }}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function SegmentedControl<T extends string | number>({ label, options, value, onChange }: {
  label: string
  options: ReadonlyArray<{ label: string; value: T }>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex gap-1 p-1 rounded-full" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.label}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className="h-[30px] px-3.5 rounded-full text-xs font-semibold focus-ring"
            style={{
              background: active ? 'var(--admin-selection)' : 'transparent',
              color: active ? 'var(--m3-on-surface)' : 'var(--m3-secondary)',
              border: `1px solid ${active ? 'var(--admin-selection-border)' : 'transparent'}`,
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

const BAR_BACKGROUND: Record<UptimeDayStatus, string> = {
  up: 'linear-gradient(to top, var(--m3-up-bar), color-mix(in srgb, var(--m3-up-bar) 55%, white))',
  degraded: 'var(--m3-degraded-bar)',
  partial: 'var(--m3-partial-bar)',
  down: 'var(--m3-down)',
  'no-data': 'var(--m3-outline-variant)',
}

const STEP_TITLE: Record<number, string> = { 1: 'Hourly uptime', 6: 'Uptime per 6 hours', 24: 'Daily uptime' }

function barRange(ts: number, stepHours: number): string {
  if (stepHours >= 24) return formatDate(ts, true)
  return `${formatDayMonth(ts)}, ${formatClock(ts)}–${formatClock(ts + stepHours * 3_600_000)}`
}

/** One bar per hour, six hours or UTC day depending on the range, in the style of the public status page. */
function UptimeBars({ stats }: { stats: MonitorStats }) {
  const [active, setActive] = useState<number | null>(null)
  const { stepHours, bars } = stats.uptime
  const items = bars.map((bar) => {
    const uptimePct = bar.checksTotal > 0 ? (bar.checksUp / bar.checksTotal) * 100 : null
    return { ...bar, uptimePct, status: classifyUptimeDay(uptimePct, DEFAULT_UPTIME_THRESHOLDS) }
  })
  const hoveredIndex = items.findIndex((item) => item.ts === active)
  const hovered = hoveredIndex >= 0 ? items[hoveredIndex]! : null
  const span = stats.hours >= 48 ? `${Math.round(stats.hours / 24)} days ago` : `${stats.hours} hours ago`

  return (
    <div className="relative">
      {hovered && (
        <div
          role="tooltip"
          className="absolute bottom-full mb-2 z-10 rounded-xl px-3.5 py-3 text-xs pointer-events-none"
          style={{
            left: `clamp(0px, calc(${((hoveredIndex + 0.5) / items.length) * 100}% - 110px), calc(100% - 220px))`,
            width: 220,
            background: 'var(--m3-surface-container-high)',
            border: '1px solid var(--m3-outline-variant)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          }}
        >
          <div className="font-bold" style={{ color: 'var(--m3-on-surface)' }}>{barRange(hovered.ts, stepHours)}</div>
          <div className="mt-1 font-semibold" style={{ color: 'var(--m3-secondary)' }}>
            {hovered.uptimePct === null ? 'No data' : `${formatPct(hovered.uptimePct)} · ${hovered.checksUp}/${hovered.checksTotal} checks`}
          </div>
        </div>
      )}
      <div className="flex items-end h-10" style={{ gap: 2 }} role="list" aria-label={STEP_TITLE[stepHours]}>
        {items.map((item) => (
          <button
            key={item.ts}
            type="button"
            role="listitem"
            aria-label={`${barRange(item.ts, stepHours)}: ${item.uptimePct === null ? 'no data' : formatPct(item.uptimePct)}`}
            onMouseEnter={() => setActive(item.ts)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(item.ts)}
            onBlur={() => setActive(null)}
            className="flex-1 min-w-0 h-full p-0 border-0"
            style={{
              borderRadius: 2,
              background: BAR_BACKGROUND[item.status],
              opacity: item.status === 'no-data' ? 0.35 : 1,
              filter: active === item.ts ? 'brightness(1.5)' : undefined,
            }}
          />
        ))}
      </div>
      <div className="flex justify-between mt-2 text-[11px]" style={{ color: 'var(--m3-secondary)' }}>
        <span>{span}</span>
        <span>Now</span>
      </div>
    </div>
  )
}

function Percentiles({ stats }: { stats: MonitorStats }) {
  if (!stats.response) return <p className="text-sm" style={{ color: 'var(--m3-secondary)' }}>No response times in this range.</p>
  const { response } = stats
  const rows: Array<[string, number]> = [['Min', response.min], ['p50', response.p50], ['p95', response.p95], ['p99', response.p99], ['Max', response.max]]
  return (
    <div className="flex flex-col gap-2.5 text-xs">
      {rows.map(([label, value]) => (
        <div key={label}>
          <div className="flex justify-between mb-1">
            <span style={{ color: 'var(--m3-secondary)' }}>{label}</span>
            <b style={{ color: 'var(--m3-on-surface)' }}>{formatMs(value)}</b>
          </div>
          <div className="h-1.5 rounded-full" style={{ background: 'var(--m3-surface-container-high)' }}>
            <div className="h-full rounded-full" style={{ width: `${Math.max(2, (value / response.max) * 100)}%`, background: 'var(--m3-primary)' }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function monitorTarget(monitor: Monitor): string | null {
  switch (monitor.type) {
    case 'https': return (monitor.config as HttpsConfig).url
    case 'ping': return (monitor.config as PingConfig).host
    case 'dns': return (monitor.config as DnsConfig).hostname
    case 'docker': return (monitor.config as DockerConfig).container
    case 'webhook': return null
    default: return (monitor.config as { host?: string }).host ?? null
  }
}

function certificateText(monitor: Monitor): string | null {
  if (monitor.type !== 'https' || typeof monitor.certExpiresAt !== 'number') return null
  const days = Math.floor((monitor.certExpiresAt - Date.now()) / DAY_MS)
  return days < 0 ? 'Expired' : `${days} ${days === 1 ? 'day' : 'days'} left`
}

export default function MonitorDetailPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const toast = useToast()
  const [hours, setHours] = useState<number>(168)
  const [metric, setMetric] = useState<ChartMetric>('avg')
  const [editing, setEditing] = useState(false)

  const monitorQuery = useQuery<Monitor>({
    queryKey: ['monitor', id],
    queryFn: () => api.get(`/admin/monitors/${id}`),
  })
  const statsQuery = useQuery<MonitorStats>({
    queryKey: ['monitor-stats', id, hours],
    queryFn: () => api.get(`/admin/monitors/${id}/stats?hours=${hours}`),
    refetchInterval: 60_000,
  })
  const dependenciesQuery = useQuery<{ dependsOnIds: number[] }>({
    queryKey: ['monitor-dependencies', id],
    queryFn: () => api.get(`/admin/monitors/${id}/dependencies`),
  })
  const { data: monitors = [] } = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
  })

  const checkNow = useMutation({
    mutationFn: () => api.post(`/admin/monitors/${id}/check-now`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['monitor', id] })
      void qc.invalidateQueries({ queryKey: ['monitor-stats', id] })
      toast.success('Check finished')
    },
    onError: (err) => toast.error(`Couldn't run the check: ${(err as Error).message}`),
  })

  if (monitorQuery.isPending) return <PageContainer><LoadingState label="Loading monitor…" /></PageContainer>
  if (monitorQuery.isError || !monitorQuery.data) {
    return (
      <PageContainer>
        <ErrorState message="Couldn't load this monitor. It may have been deleted." onRetry={() => void monitorQuery.refetch()} />
        <Link to="/admin/monitors" className="btn btn-outline btn-sm">Back to monitors</Link>
      </PageContainer>
    )
  }

  const monitor = monitorQuery.data
  const stats = statsQuery.data
  const beyondRetention = stats !== undefined && hours > stats.retentionDays * 24
  const typeLabel = MONITOR_TYPES.find((t) => (t.types ?? [t.value]).includes(monitor.type))?.label ?? monitor.type
  const target = monitorTarget(monitor)
  const certificate = certificateText(monitor)
  const dependencyNames = (dependenciesQuery.data?.dependsOnIds ?? []).map((depId) => monitors.find((m) => m.id === depId)?.name ?? `Monitor ${depId}`)
  const rangeLabel = RANGES.find((r) => r.hours === hours)?.label ?? `${hours}h`

  return (
    <PageContainer>
      <Link to="/admin/monitors" className="-mb-3 inline-flex items-center gap-1 text-xs focus-ring rounded" style={{ color: 'var(--m3-secondary)' }}>
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 16 }}>arrow_back</span>
        Monitors
      </Link>
      <PageHeader
        title={<span className="inline-flex flex-wrap items-center gap-3">{monitor.name} <StatusBadge status={monitor.currentStatus} /></span>}
        subtitle={`${typeLabel} · every ${monitor.intervalSecs}s · last check ${monitor.lastCheckedAt ? dateTime(monitor.lastCheckedAt) : 'never'}`}
        actions={<>
          <SegmentedControl label="Time range" options={RANGES.map((r) => ({ label: r.label, value: r.hours }))} value={hours} onChange={setHours} />
          {monitor.type !== 'webhook' && (
            <button type="button" className="btn btn-outline" disabled={checkNow.isPending} onClick={() => checkNow.mutate()}>
              <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
              {checkNow.isPending ? 'Checking…' : 'Check now'}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => setEditing(true)}>
            <span className="material-symbols-outlined" aria-hidden="true">edit</span>
            Edit
          </button>
        </>}
      />

      {beyondRetention && (
        <Alert tone="info">
          Check results are kept for {stats.retentionDays} days (<code>MONITOR_RESULT_RETENTION_DAYS</code>), so this range is shown for the last {stats.retentionDays} days only.
        </Alert>
      )}

      {statsQuery.isError ? (
        <ErrorState message="Couldn't load the statistics." onRetry={() => void statsQuery.refetch()} />
      ) : stats === undefined ? (
        <LoadingState label="Loading statistics…" />
      ) : (
        <div className="flex flex-wrap gap-5 items-start">
          <div className="flex-[1_1_640px] min-w-0 flex flex-col gap-5">
            <Card
              title="Response time"
              aside={<SegmentedControl label="Metric" options={METRICS} value={metric} onChange={setMetric} />}
            >
              <div className="mb-2">
                <div className={LABEL} style={{ color: 'var(--m3-outline)' }}>Avg response · {rangeLabel}</div>
                <div className="font-headline font-extrabold text-3xl mt-1" style={{ color: 'var(--m3-on-surface)' }}>
                  {stats.response ? formatMs(stats.response.avg) : '—'}
                </div>
              </div>
              <ResponseTimeChart stats={stats} metric={metric} />
            </Card>

            <Card title={STEP_TITLE[stats.uptime.stepHours] ?? 'Uptime'} aside={stats.uptime.stepHours >= 24 ? <span className="text-sm" style={{ color: 'var(--m3-secondary)' }}>UTC days</span> : undefined}>
              <UptimeBars stats={stats} />
            </Card>

            <Card title="Recent failures">
              {stats.recentFailures.length === 0 ? (
                <EmptyState icon="check_circle" title="No failed checks in this range." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] table-fixed text-sm">
                    <colgroup>
                      <col style={{ width: 168 }} />
                      <col style={{ width: 150 }} />
                      <col />
                    </colgroup>
                    <thead>
                      <tr className={`${LABEL} text-left`} style={{ color: 'var(--m3-outline)' }}>
                        <th scope="col" className="py-2 pr-4 font-normal">Time</th>
                        <th scope="col" className="py-2 pr-4 font-normal">Status</th>
                        <th scope="col" className="py-2 font-normal">Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.recentFailures.map((failure) => (
                        <tr key={failure.checkedAt} style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
                          <td className="py-2 pr-4 align-top font-mono text-xs whitespace-nowrap">{dateTime(failure.checkedAt)}</td>
                          <td className="py-2 pr-4 align-top">
                            <StatusBadge status={failure.status} />
                            {failure.unconfirmed && <div className="mt-1 text-xs" style={{ color: 'var(--m3-secondary)' }}>unconfirmed</div>}
                          </td>
                          <td className="py-2 align-top break-words" style={{ color: 'var(--m3-secondary)' }}>{failure.errorMessage ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          <aside className="flex-[0_1_320px] min-w-[260px] flex flex-col gap-5">
            <Card title="Summary">
              <Rows rows={[
                ['Uptime', formatPct(stats.uptimePct)],
                ['Checks', `${stats.checksUp} / ${stats.checksTotal}`],
                ['Failed checks', stats.failures],
                ['Incidents', stats.incidents.total],
                ['MTTR', formatDuration(stats.incidents.mttrMs)],
              ]} />
            </Card>

            <Card title="Response percentiles">
              <Percentiles stats={stats} />
            </Card>

            <Card title="Configuration">
              <Rows rows={[
                ['Type', typeLabel],
                ...(target ? [['Target', target] as [string, ReactNode]] : []),
                ['Interval', `${monitor.intervalSecs} s`],
                ['Timeout', `${monitor.timeoutMs / 1000} s`],
                ['Alert after', `${monitor.failureThreshold} ${monitor.failureThreshold === 1 ? 'failure' : 'failures'}`],
                ['Recover after', `${monitor.recoveryThreshold} ${monitor.recoveryThreshold === 1 ? 'success' : 'successes'}`],
                ...(dependencyNames.length > 0 ? [['Depends on', dependencyNames.join(', ')] as [string, ReactNode]] : []),
                ...(certificate ? [['Certificate', certificate] as [string, ReactNode]] : []),
              ]} />
            </Card>

            <Card title="Incidents">
              {stats.incidents.recent.length === 0 ? (
                <EmptyState icon="check_circle" title="No incidents in this range." />
              ) : (
                <ul>
                  {stats.incidents.recent.map((incident, i) => (
                    <li key={incident.id} className="py-2.5" style={i > 0 ? { borderTop: '1px solid var(--m3-outline-variant)' } : undefined}>
                      <b className="text-sm" style={{ color: 'var(--m3-on-surface)' }}>{incident.title}</b>
                      <div className="mt-1 text-xs" style={{ color: 'var(--m3-secondary)' }}>
                        {formatDate(incident.startedAt)} · {incident.impact} · {incident.resolvedAt ? formatDuration(incident.resolvedAt - incident.startedAt) : 'ongoing'}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </aside>
        </div>
      )}

      {editing && (
        <MonitorFormModal
          monitor={monitor}
          allTags={[...new Map(monitors.flatMap((m) => m.tags ?? []).map((t) => [t.label, t])).values()]}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            void qc.invalidateQueries({ queryKey: ['monitor', id] })
            void qc.invalidateQueries({ queryKey: ['monitors'] })
          }}
        />
      )}
    </PageContainer>
  )
}
