import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'

type ComponentStatus = 'ok' | 'attention' | 'error' | 'disabled'

interface SystemHealthReport {
  status: 'healthy' | 'degraded'
  generatedAt: number
  application: { status: 'ok'; version: string; uptimeSeconds: number }
  database: { status: 'ok' | 'error'; responseMs: number | null }
  monitoring: {
    status: ComponentStatus
    schedulerRunning: boolean
    configuredMonitors: number | null
    overdueMonitors: number | null
    lastMonitorCheckAt: number | null
    lastTickStartedAt: number | null
    lastTickCompletedAt: number | null
    lastTickDurationMs: number | null
    lastTickDueMonitors: number
    lastTickFailedChecks: number
  }
  notifications: { status: ComponentStatus; pending: number | null; failed: number | null; lastDeliveredAt: number | null }
  backups: {
    status: ComponentStatus
    scheduleEnabled: boolean
    state: 'idle' | 'running' | 'success' | 'error'
    storedBackups: number | null
    latestBackupAt: number | null
    lastCompletedAt: number | null
  }
}

function formatDate(value: number | null) {
  return value === null ? 'Never' : new Date(value).toLocaleString()
}

function formatUptime(totalSeconds: number) {
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor(totalSeconds % 86_400 / 3_600)
  const minutes = Math.floor(totalSeconds % 3_600 / 60)
  return [days && `${days}d`, (days || hours) && `${hours}h`, `${minutes}m`].filter(Boolean).join(' ')
}

function StatusBadge({ status }: { status: ComponentStatus | 'healthy' | 'degraded' }) {
  const palette = status === 'ok' || status === 'healthy'
    ? { background: 'var(--m3-up-bg)', color: 'var(--m3-up)' }
    : status === 'disabled'
      ? { background: 'var(--m3-surface-container-high)', color: 'var(--m3-secondary)' }
      : status === 'attention'
        ? { background: 'var(--m3-degraded-bg)', color: 'var(--m3-degraded)' }
        : { background: 'var(--m3-error-container)', color: 'var(--m3-on-error-container)' }
  return <span className="rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide" style={palette}>{status}</span>
}

function HealthCard({ icon, title, status, children }: {
  icon: string
  title: string
  status: ComponentStatus | 'ok' | 'error'
  children: React.ReactNode
}) {
  return (
    <section className="rounded-2xl p-5 md:p-6 space-y-5" style={{ background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)' }}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined rounded-xl p-2.5" style={{ background: 'var(--admin-icon-container)', color: 'var(--admin-icon-color)' }}>{icon}</span>
          <h2 className="font-headline text-xl font-semibold">{title}</h2>
        </div>
        <StatusBadge status={status} />
      </div>
      <dl className="grid gap-4 sm:grid-cols-2">{children}</dl>
    </section>
  )
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--m3-secondary)' }}>{label}</dt><dd className="mt-1 font-medium">{value}</dd></div>
}

export default function SystemHealthPage() {
  const [report, setReport] = useState<SystemHealthReport | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true)
    try {
      setReport(await api.get<SystemHealthReport>('/admin/system-health'))
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (manual) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => { void load() }, 15_000)
    return () => window.clearInterval(interval)
  }, [load])

  if (!report && !error) return <div className="p-8" style={{ color: 'var(--m3-on-surface)' }}>Loading system health…</div>

  return (
    <div className="p-6 md:p-10 max-w-6xl mx-auto space-y-6" style={{ color: 'var(--m3-on-surface)' }}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="text-3xl font-bold">System Health</h1><p style={{ color: 'var(--m3-secondary)' }}>Internal health of this BetterStatusPage instance.</p></div>
        <button type="button" disabled={refreshing} onClick={() => { void load(true) }} className="btn-primary px-5 py-2.5 rounded-xl">
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="rounded-xl p-4" style={{ background: 'var(--m3-error-container)', color: 'var(--m3-on-error-container)' }}>{error}</div>}

      {report && <>
        <div className="rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4" style={{ background: report.status === 'healthy' ? 'var(--m3-up-bg)' : 'var(--m3-error-container)' }}>
          <div><p className="font-headline text-xl font-semibold">{report.status === 'healthy' ? 'BetterStatusPage is healthy' : 'BetterStatusPage needs attention'}</p><p className="text-sm opacity-80">Updated {new Date(report.generatedAt).toLocaleString()} · refreshes every 15 seconds</p></div>
          <StatusBadge status={report.status} />
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <HealthCard icon="deployed_code" title="Application" status={report.application.status}>
            <Metric label="Version" value={report.application.version} />
            <Metric label="Process uptime" value={formatUptime(report.application.uptimeSeconds)} />
          </HealthCard>

          <HealthCard icon="database" title="Database" status={report.database.status}>
            <Metric label="Connection" value={report.database.status === 'ok' ? 'Available' : 'Unavailable'} />
            <Metric label="Response time" value={report.database.responseMs === null ? 'Unavailable' : `${report.database.responseMs} ms`} />
          </HealthCard>

          <HealthCard icon="monitor_heart" title="Monitor scheduler" status={report.monitoring.status}>
            <Metric label="Scheduler" value={report.monitoring.schedulerRunning ? 'Running' : 'Stopped'} />
            <Metric label="Configured monitors" value={report.monitoring.configuredMonitors ?? 'Unavailable'} />
            <Metric label="Overdue monitors" value={report.monitoring.overdueMonitors ?? 'Unavailable'} />
            <Metric label="Latest stored check" value={formatDate(report.monitoring.lastMonitorCheckAt)} />
            <Metric label="Last scheduler tick" value={formatDate(report.monitoring.lastTickCompletedAt)} />
            <Metric label="Last tick duration" value={report.monitoring.lastTickDurationMs === null ? 'Never' : `${report.monitoring.lastTickDurationMs} ms`} />
            <Metric label="Checks due in last tick" value={report.monitoring.lastTickDueMonitors} />
            <Metric label="Failed jobs in last tick" value={report.monitoring.lastTickFailedChecks} />
          </HealthCard>

          <HealthCard icon="notifications_active" title="Notification delivery" status={report.notifications.status}>
            <Metric label="Pending deliveries" value={report.notifications.pending ?? 'Unavailable'} />
            <Metric label="Failed deliveries" value={report.notifications.failed ?? 'Unavailable'} />
            <Metric label="Last delivered" value={formatDate(report.notifications.lastDeliveredAt)} />
          </HealthCard>

          <HealthCard icon="backup" title="Backups" status={report.backups.status}>
            <Metric label="Automatic schedule" value={report.backups.scheduleEnabled ? 'Enabled' : 'Disabled'} />
            <Metric label="Last operation" value={report.backups.state} />
            <Metric label="Stored backups" value={report.backups.storedBackups ?? 'Unavailable'} />
            <Metric label="Latest backup" value={formatDate(report.backups.latestBackupAt)} />
            <Metric label="Last completed operation" value={formatDate(report.backups.lastCompletedAt)} />
          </HealthCard>
        </div>
      </>}
    </div>
  )
}
