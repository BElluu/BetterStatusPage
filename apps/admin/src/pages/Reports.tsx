import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Monitor, UptimeReport } from '@bsp/shared'
import { Alert, EmptyTableRow, ErrorState, LoadingState, PageContainer, PageHeader, useToast } from '../components/ui'

const DAY_MS = 86_400_000
const MAX_RANGE_DAYS = 366
const PRESETS = [7, 30, 90] as const
const FILTER_LABEL = 'font-mono text-[10px] uppercase tracking-widest'

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const todayUtc = () => isoDay(Date.now())
const daysAgoUtc = (days: number) => isoDay(Date.now() - days * DAY_MS)
const spanDays = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY_MS + 1

function formatPct(value: number | null) {
  return value === null ? '—' : `${value.toFixed(3)}%`
}

export default function ReportsPage() {
  const idPrefix = useId()
  const toast = useToast()
  const [from, setFrom] = useState(() => daysAgoUtc(29))
  const [to, setTo] = useState(todayUtc)
  const [monitorId, setMonitorId] = useState('')

  const rangeError = !from || !to
    ? 'Choose both dates.'
    : from > to
      ? 'The start date must not be after the end date.'
      : spanDays(from, to) > MAX_RANGE_DAYS
        ? `The range must not exceed ${MAX_RANGE_DAYS} days.`
        : ''

  const { data: monitors = [] } = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
  })

  const params = new URLSearchParams({ from, to })
  if (monitorId) params.set('monitorId', monitorId)
  const query = params.toString()

  const { data: report, isPending, isError, refetch } = useQuery<UptimeReport>({
    queryKey: ['uptime-report', query],
    queryFn: () => api.get(`/admin/reports/uptime?${query}`),
    enabled: !rangeError,
  })

  function exportCsv(granularity: 'day' | 'total') {
    api.download(`/admin/reports/uptime/export?${query}&granularity=${granularity}`, `uptime-${granularity === 'day' ? 'daily' : 'summary'}-${from}-${to}.csv`)
      .catch(() => toast.error('Export failed'))
  }

  const beyondRetention = report !== undefined && from < daysAgoUtc(report.retentionDays - 1)

  return (
    <PageContainer>
      <PageHeader
        title="Reports"
        subtitle="Uptime per monitor over a date range. Days are UTC days, and a failure not yet confirmed by the monitor's failure threshold does not lower uptime."
        actions={<>
          <button type="button" disabled={Boolean(rangeError)} onClick={() => exportCsv('total')} className="btn btn-outline">
            <span className="material-symbols-outlined" aria-hidden="true">download</span>
            Export summary CSV
          </button>
          <button type="button" disabled={Boolean(rangeError)} onClick={() => exportCsv('day')} className="btn btn-outline">
            <span className="material-symbols-outlined" aria-hidden="true">download</span>
            Export daily CSV
          </button>
        </>}
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${idPrefix}-from`} className={FILTER_LABEL} style={{ color: 'var(--m3-outline)' }}>From</label>
            <input id={`${idPrefix}-from`} type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="input-sig" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${idPrefix}-to`} className={FILTER_LABEL} style={{ color: 'var(--m3-outline)' }}>To</label>
            <input id={`${idPrefix}-to`} type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="input-sig" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${idPrefix}-monitor`} className={FILTER_LABEL} style={{ color: 'var(--m3-outline)' }}>Monitor</label>
            <select id={`${idPrefix}-monitor`} value={monitorId} onChange={(e) => setMonitorId(e.target.value)} className="input-sig">
              <option value="">All monitors</option>
              {monitors.map((monitor) => <option key={monitor.id} value={monitor.id}>{monitor.name}</option>)}
            </select>
          </div>
          <div className="flex gap-2" role="group" aria-label="Quick ranges">
            {PRESETS.map((days) => (
              <button key={days} type="button" className="btn btn-outline btn-sm" onClick={() => { setFrom(daysAgoUtc(days - 1)); setTo(todayUtc()) }}>
                Last {days} days
              </button>
            ))}
          </div>
        </div>
      </PageHeader>

      {rangeError && <Alert tone="warning">{rangeError}</Alert>}
      {beyondRetention && (
        <Alert tone="info">
          Check results are kept for {report.retentionDays} days (<code>MONITOR_RESULT_RETENTION_DAYS</code>), so earlier days of this range have no data.
        </Alert>
      )}

      {rangeError ? null : isPending ? (
        <LoadingState label="Loading report…" />
      ) : isError ? (
        <ErrorState message="Failed to load the report." onRetry={() => void refetch()} />
      ) : (
        <div className="rounded-2xl overflow-x-auto" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
                {['Monitor', 'Uptime', 'Checks', 'Successful', 'Avg response', 'Incidents'].map((label, index) => (
                  <th
                    key={label}
                    scope="col"
                    className={`px-4 py-3 font-mono text-xs uppercase tracking-wider ${index === 0 ? 'text-left' : 'text-right'}`}
                    style={{ color: 'var(--m3-secondary)', background: 'var(--m3-surface-container)', whiteSpace: 'nowrap' }}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.monitors.length === 0 && <EmptyTableRow colSpan={6} icon="assessment" title="No monitors" description="Create a monitor to see its uptime here." />}
              {report.monitors.map((monitor) => (
                <tr key={monitor.monitorId} style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
                  <td className="px-4 py-3 font-medium">{monitor.monitorName}</td>
                  <td className="px-4 py-3 text-right font-mono">{formatPct(monitor.uptimePct)}</td>
                  <td className="px-4 py-3 text-right font-mono">{monitor.checksTotal.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right font-mono">{monitor.checksUp.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right font-mono">{monitor.avgResponseMs === null ? '—' : `${Math.round(monitor.avgResponseMs)} ms`}</td>
                  <td className="px-4 py-3 text-right font-mono">{monitor.incidents}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageContainer>
  )
}
