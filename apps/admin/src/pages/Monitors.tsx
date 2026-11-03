import { useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { DEFAULT_CERT_WARN_DAYS } from '@bsp/shared'
import type { HttpsConfig, Monitor, MonitorStatus, MonitorListItem, MonitorType } from '@bsp/shared'
import { ActivityBadges, MonitorStatusBadge, effectiveStatus } from '../components/monitors/StatusBadge'
import MonitorFormModal from '../components/monitors/MonitorFormModal'
import { YamlViewModal } from '../components/YamlViewModal'
import { MONITOR_TYPES } from '../components/monitors/monitorTypes'
import { ConfirmModal } from '@better-forge/ui'
import { DataTable, DataTh, useTableSort } from '@better-forge/ui'
import { EmptyStateLink, EmptyTableRow, ErrorState, LoadingState, PageContainer, PageHeader, QuickStartPanel, useToast, type QuickStartOption } from '@better-forge/ui'
import { formatDateTime } from '@better-forge/ui'
import { ActionMenu } from '../components/ActionMenu'
import { STATUS_SEVERITY, failingFor, formatPercent, isSlower, monitorEndpoint } from '../components/monitors/monitorDisplay'
import { Sparkline } from '../components/monitors/Sparkline'
import { formatAgo, useNow } from '../relativeTime'

type StatusFilter = 'all' | 'down' | 'degraded' | 'up'
const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'down', label: 'Down' }, { value: 'degraded', label: 'Degraded' }, { value: 'up', label: 'Operational' },
]

const COMPACT_KEY = 'bsp.monitors.compact'
function readCompact(): boolean {
  try { return localStorage.getItem(COMPACT_KEY) === '1' } catch { return false }
}

const MONITOR_QUICK_START: QuickStartOption<MonitorType>[] = MONITOR_TYPES.map((t) => ({
  key: t.value,
  label: t.label,
  hint: t.hint,
  icon: <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>{t.icon}</span>,
}))

export default function MonitorsPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const [editingMonitor, setEditingMonitor] = useState<Monitor | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showYaml, setShowYaml] = useState(false)
  const [createType, setCreateType] = useState<MonitorType | undefined>(undefined)
  const [confirmDelete, setConfirmDelete] = useState<Monitor | null>(null)
  const [activeTags, setActiveTags] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const now = useNow()
  const [compact, setCompact] = useState(readCompact)
  const cell = compact ? 'px-4 py-1.5' : 'px-4 py-3'
  function chooseCompact(value: boolean) {
    setCompact(value)
    try { localStorage.setItem(COMPACT_KEY, value ? '1' : '0') } catch { /* the choice is just not remembered */ }
  }

  const { data: monitors = [], isPending, isError, refetch } = useQuery<MonitorListItem[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
    refetchInterval: 30_000,
  })

  // Live updates via SSE — updates status and lastCheckedAt instantly on every check
  useEffect(() => {
    let es: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let closed = false
    let retryMs = 2000
    function connect() {
      if (closed) return
      es = new EventSource('/api/v1/admin/monitors/events')
      es.onopen = () => { retryMs = 2000 }
      es.addEventListener('monitor.status', (e) => {
        const data = JSON.parse(e.data) as { monitorId: number; status: MonitorStatus; responseMs: number | null; checkedAt: number }
        qc.setQueryData<Monitor[]>(['monitors'], (old) =>
          old?.map((m) => m.id === data.monitorId
            ? { ...m, currentStatus: data.status, lastCheckedAt: data.checkedAt }
            : m,
          ),
        )
      })
      // The stream ends when the session is revoked. Check the session before reconnecting: the API
      // client sends a signed-out user to the login page instead of retrying forever.
      es.onerror = () => {
        es?.close()
        es = null
        if (closed) return
        retryTimer = setTimeout(() => {
          api.get('/auth/session').then(connect, () => { /* redirected to login */ })
        }, retryMs)
        retryMs = Math.min(retryMs * 2, 60_000)
      }
    }
    connect()
    return () => { closed = true; if (retryTimer) clearTimeout(retryTimer); es?.close() }
  }, [qc])

  const deleteMutation = useMutation({
    mutationFn: (monitor: Monitor) => api.delete(`/admin/monitors/${monitor.id}`),
    onSuccess: (_data, monitor) => {
      qc.invalidateQueries({ queryKey: ['monitors'] })
      setConfirmDelete(null)
      toast.success(`Deleted "${monitor.name}"`)
    },
    onError: (err) => toast.error(`Couldn't delete monitor: ${(err as Error).message}`),
  })

  const checkNowMutation = useMutation({
    mutationFn: (monitor: Monitor) => api.post(`/admin/monitors/${monitor.id}/check-now`, {}),
    onSuccess: (_data, monitor) => {
      qc.invalidateQueries({ queryKey: ['monitors'] })
      toast.success(`Checked "${monitor.name}"`)
    },
    onError: (err, monitor) => toast.error(`Couldn't check "${monitor.name}": ${(err as Error).message}`),
  })

  const checkingId = checkNowMutation.isPending ? (checkNowMutation.variables?.id ?? null) : null

  function openCreate(type?: MonitorType) {
    setCreateType(type)
    setShowCreate(true)
  }

  const allTags = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of monitors) {
      for (const t of (m.tags ?? [])) {
        if (!map.has(t.label)) map.set(t.label, t.color)
      }
    }
    return [...map.entries()].map(([label, color]) => ({ label, color }))
  }, [monitors])

  const statusCounts = useMemo(() => {
    const counts = { all: monitors.length, down: 0, degraded: 0, up: 0 }
    for (const m of monitors) {
      const s = effectiveStatus(m)
      if (s === 'down' || s === 'degraded' || s === 'up') counts[s]++
    }
    return counts
  }, [monitors])
  const types = useMemo(() => [...new Set(monitors.map((m) => m.type))].sort(), [monitors])

  const needle = search.trim().toLowerCase()
  const filtered = useMemo(
    () => monitors.filter((m) =>
      activeTags.every((tag) => (m.tags ?? []).some((t) => t.label === tag))
      && (statusFilter === 'all' || effectiveStatus(m) === statusFilter)
      && (typeFilter === 'all' || m.type === typeFilter)
      && (!needle || m.name.toLowerCase().includes(needle) || m.type.toLowerCase().includes(needle) || monitorEndpoint(m).toLowerCase().includes(needle))),
    [monitors, activeTags, statusFilter, typeFilter, needle],
  )
  function clearFilters() { setActiveTags([]); setSearch(''); setStatusFilter('all'); setTypeFilter('all') }

  // Worst status first by default, so an outage is never below the fold.
  const { rows: displayed, sort } = useTableSort(filtered, {
    name: (m) => m.name,
    uptime: (m) => m.health.uptime24h,
    response: (m) => m.health.avgResponseMs,
    currentStatus: (m) => STATUS_SEVERITY[effectiveStatus(m)],
    lastCheckedAt: (m) => m.lastCheckedAt,
  }, { key: 'currentStatus' })

  return (
    <PageContainer>
      <PageHeader
        title="Monitors"
        subtitle={isPending || isError ? undefined : `${monitors.length} monitor${monitors.length !== 1 ? 's' : ''}`}
        actions={<>
          <button type="button" onClick={() => openCreate()} className="btn btn-primary">
            <span className="material-symbols-outlined" aria-hidden="true">add_circle</span>
            Add Monitor
          </button>
          <ActionMenu
            label="More actions"
            buttonClassName="btn btn-secondary"
            items={[
              { label: 'Export YAML', icon: 'data_object', onSelect: () => setShowYaml(true) },
              { label: 'Import YAML', icon: 'upload_file', to: '/admin/import', state: { from: 'monitors' } },
            ]}
          />
        </>}
      />

      {/* Tag filter bar */}
      {allTags.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Filter by tag">
          <span className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Filter:</span>
          {allTags.map((t) => {
            const active = activeTags.includes(t.label)
            return (
              <button key={t.label} type="button" aria-pressed={active}
                onClick={() => setActiveTags((prev) => active ? prev.filter((l) => l !== t.label) : [...prev, t.label])}
                className="text-xs px-2.5 py-1 rounded-full font-medium transition-all focus-ring"
                style={active
                  ? { background: `${t.color}2a`, color: t.color, border: `1px solid ${t.color}66` }
                  : { background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)', border: '1px solid var(--m3-outline-variant)' }
                }
              >
                {t.label}
              </button>
            )
          })}
          {activeTags.length > 0 && (
            <button type="button" onClick={() => setActiveTags([])} className="btn btn-ghost btn-sm">Clear</button>
          )}
        </div>
      )}

      {monitors.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" style={{ fontSize: '18px', color: 'var(--m3-secondary)' }}>search</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, URL or type"
              aria-label="Search monitors"
              className="w-full rounded-lg pl-9 pr-3 py-2 text-sm border border-transparent focus:outline-none focus:border-outline-variant"
              style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-on-surface)' }}
            />
          </div>
          <div className="inline-flex rounded-lg p-0.5" role="group" aria-label="Filter by status" style={{ background: 'var(--m3-surface-container)' }}>
            {STATUS_FILTERS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                aria-pressed={statusFilter === value}
                onClick={() => setStatusFilter(value)}
                className="px-3 py-1.5 rounded-md text-sm font-medium focus-ring"
                style={statusFilter === value ? { background: 'var(--m3-surface-container-high)', color: 'var(--m3-on-surface)' } : { color: 'var(--m3-on-surface-variant)' }}
              >
                {label}<span className="ml-1.5 text-xs" style={{ color: 'var(--m3-secondary)' }}>{statusCounts[value]}</span>
              </button>
            ))}
          </div>
          {types.length > 1 && (
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              aria-label="Filter by type"
              className="rounded-lg px-3 py-2 text-sm border border-transparent focus:outline-none focus:border-outline-variant"
              style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-on-surface)' }}
            >
              <option value="all">All types</option>
              {types.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          <div className="inline-flex rounded-lg p-0.5 ml-auto" role="group" aria-label="Row density" style={{ background: 'var(--m3-surface-container)' }}>
            {([[false, 'density_medium', 'Comfortable rows'], [true, 'density_small', 'Compact rows']] as const).map(([value, icon, label]) => (
              <button
                key={label}
                type="button"
                aria-pressed={compact === value}
                aria-label={label}
                title={label}
                onClick={() => chooseCompact(value)}
                className="px-2 py-1.5 rounded-md focus-ring"
                style={compact === value ? { background: 'var(--m3-surface-container-high)', color: 'var(--m3-on-surface)' } : { color: 'var(--m3-on-surface-variant)' }}
              >
                <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px', display: 'block' }}>{icon}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {isPending ? (
        <LoadingState label="Loading monitors…" />
      ) : isError ? (
        <ErrorState message="Couldn't load monitors." onRetry={() => void refetch()} />
      ) : monitors.length === 0 ? (
        <QuickStartPanel
          title="What should we check first?"
          description="Pick a monitor type. You can add tags, alerts and dependencies in the same form."
          options={MONITOR_QUICK_START}
          onPick={openCreate}
        />
      ) : (
        <div className="rounded-2xl overflow-x-auto" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          <DataTable sort={sort} className="w-full min-w-[720px] text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
                {([['Status', 'currentStatus'], ['Name', 'name'], ['Uptime 24 h', 'uptime'], ['Response', 'response'], ['Last Check', 'lastCheckedAt']] as const).map(([label, key]) => (
                  <DataTh
                    key={key}
                    scope="col"
                    sortKey={key}
                    className="px-4 py-3 font-mono text-xs uppercase tracking-wider text-left"
                    style={{ color: 'var(--m3-secondary)', background: 'var(--m3-surface-container)', whiteSpace: 'nowrap' }}
                  >
                    {label}
                  </DataTh>
                ))}
                <DataTh
                  scope="col"
                  resizable={false}
                  className="px-4 py-3 font-mono text-xs uppercase tracking-wider text-right"
                  style={{ background: 'var(--m3-surface-container)' }}
                >
                  <span className="sr-only">Actions</span>
                </DataTh>
              </tr>
            </thead>
            <tbody>
              {displayed.map((monitor) => (
                <tr
                  key={monitor.id}
                  className={`border-t border-outline-variant first:border-t-0 transition-[background-color] ${effectiveStatus(monitor) === 'down' ? 'bg-[var(--m3-down-bg)] hover:bg-[color-mix(in_srgb,var(--m3-down)_12%,var(--m3-down-bg))]' : 'hover:bg-surface-container'}`}
                >
                  <td className={`${cell}`}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {!(effectiveStatus(monitor) === 'up' && isSlower(monitor)) && <MonitorStatusBadge monitor={monitor} detail={failingFor(monitor, now)} />}
                      <ActivityBadges activity={monitor.activity} slower={isSlower(monitor)} slowerRatio={monitor.health.latencyRatio} />
                    </div>
                  </td>
                  <td className={cell}>
                    <div className={compact ? 'flex items-center gap-2 min-w-0' : undefined}>
                      <Link to={`/admin/monitors/${monitor.id}`} className={`font-medium hover:underline focus-ring rounded ${compact ? 'shrink-0' : ''}`} style={{ color: 'var(--m3-on-surface)' }}>{monitor.name}</Link>
                      <div className={`font-mono text-xs truncate ${compact ? 'max-w-[240px]' : 'mt-0.5 max-w-[320px]'}`} style={{ color: 'var(--m3-secondary)' }}>
                        {monitorEndpoint(monitor)} · every {monitor.intervalSecs} s
                      </div>
                      {((monitor.tags ?? []).length > 0 || showsCert(monitor)) && (
                        <div className={`flex items-center gap-1 ${compact ? 'shrink-0' : 'flex-wrap mt-1'}`}>
                          {(monitor.tags ?? []).map((t, j) => {
                            const active = activeTags.includes(t.label)
                            return (
                              <button key={j} type="button" aria-pressed={active}
                                onClick={(e) => { e.stopPropagation(); setActiveTags((prev) => active ? prev.filter((l) => l !== t.label) : [...prev, t.label]) }}
                                className="text-xs px-1.5 py-0.5 rounded-full font-medium transition-all"
                                style={{ background: active ? `${t.color}33` : `${t.color}22`, color: t.color, border: `1px solid ${active ? `${t.color}66` : `${t.color}44`}` }}
                              >
                                {t.label}
                              </button>
                            )
                          })}
                          {showsCert(monitor) && <CertExpiryChip monitor={monitor} />}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className={`${cell} font-mono text-xs tabular-nums`}>
                    {monitor.health.uptime24h !== null ? formatPercent(monitor.health.uptime24h) : '—'}
                  </td>
                  <td className={`${cell}`}>
                    <Sparkline
                      values={monitor.health.responseTrend}
                      status={effectiveStatus(monitor)}
                      label={`Response time, last 24 hours${monitor.health.avgResponseMs !== null ? `, average ${Math.round(monitor.health.avgResponseMs)} ms` : ''}`}
                    />
                  </td>
                  <td className={`${cell} text-xs whitespace-nowrap`} style={{ color: 'var(--m3-secondary)' }} title={monitor.lastCheckedAt ? formatDateTime(monitor.lastCheckedAt) : undefined}>
                    {monitor.lastCheckedAt ? formatAgo(monitor.lastCheckedAt, now) : '—'}
                  </td>
                  <td className={`${cell}`}>
                    <div className="flex items-center justify-end gap-1">
                      {monitor.type !== 'webhook' && (
                        <ActionBtn
                          onClick={() => checkNowMutation.mutate(monitor)}
                          title={checkingId === monitor.id ? 'Checking…' : 'Check now'}
                          label={checkingId === monitor.id ? `Checking ${monitor.name}…` : `Check ${monitor.name} now`}
                          disabled={checkingId === monitor.id}
                        >
                          <IconRefresh spinning={checkingId === monitor.id} />
                        </ActionBtn>
                      )}
                      <ActionMenu
                        label={`More actions for ${monitor.name}`}
                        items={[
                          { label: 'Edit', icon: 'edit', onSelect: () => setEditingMonitor(monitor) },
                          { label: 'Delete', icon: 'delete', onSelect: () => setConfirmDelete(monitor), danger: true },
                        ]}
                      />
                    </div>
                  </td>
                </tr>
              ))}
              {displayed.length === 0 && (
                <EmptyTableRow
                  colSpan={6}
                  icon="filter_alt_off"
                  title="No monitors match the filters."
                  description={<>A monitor must match the search, the status and every selected tag. <EmptyStateLink onClick={clearFilters}>Clear the filters</EmptyStateLink> to see all monitors.</>}
                />
              )}
            </tbody>
          </DataTable>
        </div>
      )}

      {(showCreate || editingMonitor) && (
        <MonitorFormModal
          monitor={editingMonitor}
          initialType={createType}
          allTags={allTags}
          onClose={() => { setShowCreate(false); setEditingMonitor(null) }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['monitors'] })
            setShowCreate(false)
            setEditingMonitor(null)
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete Monitor"
          message={`Delete "${confirmDelete.name}"? This cannot be undone.`}
          pending={deleteMutation.isPending}
          pendingLabel="Deleting…"
          onConfirm={() => deleteMutation.mutate(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      {showYaml && <YamlViewModal title="All configuration" onClose={() => setShowYaml(false)} />}
    </PageContainer>
  )
}

/** Whether the monitor shows how long its TLS certificate is still valid. */
function showsCert(monitor: Monitor): boolean {
  return monitor.type === 'https' && typeof monitor.certExpiresAt === 'number' && (monitor.config as HttpsConfig).ignoreTls !== true
}

/** Days until the endpoint's certificate expires, tinted once it is inside the warning window. */
function CertExpiryChip({ monitor }: { monitor: Monitor }) {
  const expiresAt = monitor.certExpiresAt!
  const days = Math.floor((expiresAt - Date.now()) / 86_400_000)
  const certExpiry = (monitor.config as HttpsConfig).certExpiry
  const warnDays = certExpiry?.enabled ? certExpiry.warnDays : DEFAULT_CERT_WARN_DAYS
  const color = days < 0 ? 'var(--m3-down)' : days <= warnDays ? 'var(--m3-degraded)' : 'var(--m3-up)'
  return (
    <span className="font-mono text-[10px]" style={{ color }} title={`TLS certificate expires ${formatDateTime(expiresAt)}`}>
      {days < 0 ? 'TLS expired' : `TLS ${days} d`}
    </span>
  )
}

function ActionBtn({ children, onClick, title, label, danger = false, disabled = false }: {
  children: React.ReactNode; onClick: () => void; title: string; label: string; danger?: boolean; disabled?: boolean
}) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={label} disabled={disabled}
      className={danger ? 'btn-icon hover:!bg-[var(--m3-down-bg)]' : 'btn-icon'}
      style={danger ? { color: 'var(--m3-down)' } : undefined}
    >
      {children}
    </button>
  )
}

function IconRefresh({ spinning = false }: { spinning?: boolean }) {
  return <span className={`material-symbols-outlined ${spinning ? 'animate-spin' : ''}`} aria-hidden="true" style={{ fontSize: '18px' }}>refresh</span>
}
