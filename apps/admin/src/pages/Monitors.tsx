import { useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { DEFAULT_CERT_WARN_DAYS } from '@bsp/shared'
import type { HttpsConfig, Monitor, MonitorStatus, MonitorType } from '@bsp/shared'
import { StatusBadge } from '../components/monitors/StatusBadge'
import MonitorFormModal from '../components/monitors/MonitorFormModal'
import { MONITOR_TYPES } from '../components/monitors/monitorTypes'
import { ConfirmModal } from '../components/ConfirmModal'
import { EmptyStateLink, EmptyTableRow, ErrorState, LoadingState, PageContainer, PageHeader, QuickStartPanel, useToast, type QuickStartOption } from '../components/ui'

type SortCol = 'name' | 'type' | 'intervalSecs' | 'currentStatus' | 'lastCheckedAt'

const COLS: Array<{ label: string; key: SortCol | null }> = [
  { label: 'Name', key: 'name' },
  { label: 'Type', key: 'type' },
  { label: 'Interval', key: 'intervalSecs' },
  { label: 'Status', key: 'currentStatus' },
  { label: 'Last Check', key: 'lastCheckedAt' },
  { label: '', key: null },
]

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
  const [createType, setCreateType] = useState<MonitorType | undefined>(undefined)
  const [confirmDelete, setConfirmDelete] = useState<Monitor | null>(null)
  const [sortCol, setSortCol] = useState<SortCol>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [activeTags, setActiveTags] = useState<string[]>([])

  const { data: monitors = [], isPending, isError, refetch } = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
    refetchInterval: 30_000,
  })

  // Live updates via SSE — updates status and lastCheckedAt instantly on every check
  useEffect(() => {
    let es: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let closed = false
    function connect() {
      if (closed) return
      es = new EventSource('/api/v1/admin/monitors/events')
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
        }, 2000)
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

  function toggleSort(col: SortCol) {
    if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortCol(col); setSortDir('asc') }
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

  const displayed = useMemo(() => {
    let result = [...monitors]
    if (activeTags.length > 0) {
      result = result.filter((m) => activeTags.every((tag) => (m.tags ?? []).some((t) => t.label === tag)))
    }
    result.sort((a, b) => {
      const av = a[sortCol] ?? ''
      const bv = b[sortCol] ?? ''
      const al = typeof av === 'string' ? av.toLowerCase() : av
      const bl = typeof bv === 'string' ? bv.toLowerCase() : bv
      if (al < bl) return sortDir === 'asc' ? -1 : 1
      if (al > bl) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return result
  }, [monitors, sortCol, sortDir, activeTags])

  return (
    <PageContainer>
      <PageHeader
        title="Monitors"
        subtitle={isPending || isError ? undefined : `${monitors.length} monitor${monitors.length !== 1 ? 's' : ''} · Live`}
        actions={
          <button type="button" onClick={() => openCreate()} className="btn btn-primary">
            <span className="material-symbols-outlined" aria-hidden="true">add_circle</span>
            Add Monitor
          </button>
        }
      />

      {/* Tag filter bar */}
      {allTags.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
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
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
                {COLS.map(({ label, key }) => {
                  const sorted = key !== null && sortCol === key
                  return (
                    <th
                      key={label}
                      scope="col"
                      aria-sort={sorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                      className={`px-4 py-3 font-mono text-xs uppercase tracking-wider ${label === '' ? 'text-right' : 'text-left'}`}
                      style={{
                        color: sorted ? 'var(--m3-primary)' : 'var(--m3-secondary)',
                        background: 'var(--m3-surface-container)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {key ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(key)}
                          className="inline-flex items-center gap-1 uppercase tracking-wider rounded focus-ring"
                          style={{ color: 'inherit', userSelect: 'none' }}
                        >
                          {label}
                          {sorted && (
                            <span aria-hidden="true" style={{ fontSize: '10px' }}>
                              {sortDir === 'asc' ? '↑' : '↓'}
                            </span>
                          )}
                        </button>
                      ) : (
                        <span className="sr-only">Actions</span>
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {displayed.map((monitor, i) => (
                <tr
                  key={monitor.id}
                  className="transition-colors hover:bg-surface-container"
                  style={{ borderTop: i > 0 ? '1px solid var(--m3-outline-variant)' : 'none' }}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium" style={{ color: 'var(--m3-on-surface)' }}>{monitor.name}</div>
                    {monitor.type === 'https' && typeof monitor.certExpiresAt === 'number' && <CertExpiryChip monitor={monitor} />}
                    {(monitor.tags ?? []).length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
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
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs uppercase px-1.5 py-0.5 rounded"
                      style={{ color: 'var(--m3-secondary)', background: 'var(--m3-surface-container)' }}>
                      {monitor.type}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--m3-secondary)' }}>
                    {monitor.intervalSecs}s
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={monitor.currentStatus} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--m3-secondary)' }}>
                    {monitor.lastCheckedAt ? new Date(monitor.lastCheckedAt).toLocaleTimeString() : '—'}
                  </td>
                  <td className="px-4 py-3">
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
                      <ActionBtn onClick={() => setEditingMonitor(monitor)} title="Edit" label={`Edit ${monitor.name}`}>
                        <IconEdit />
                      </ActionBtn>
                      <ActionBtn onClick={() => setConfirmDelete(monitor)} title="Delete" label={`Delete ${monitor.name}`} danger>
                        <IconTrash />
                      </ActionBtn>
                    </div>
                  </td>
                </tr>
              ))}
              {displayed.length === 0 && (
                <EmptyTableRow
                  colSpan={6}
                  icon="filter_alt_off"
                  title="No monitors match the selected tags."
                  description={<>Every selected tag must be on a monitor. <EmptyStateLink onClick={() => setActiveTags([])}>Clear the filter</EmptyStateLink> to see all monitors.</>}
                />
              )}
            </tbody>
          </table>
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
    </PageContainer>
  )
}

/** Days until the endpoint's certificate expires, tinted once it is inside the warning window. */
function CertExpiryChip({ monitor }: { monitor: Monitor }) {
  const expiresAt = monitor.certExpiresAt!
  const days = Math.floor((expiresAt - Date.now()) / 86_400_000)
  const certExpiry = (monitor.config as HttpsConfig).certExpiry
  const warnDays = certExpiry?.enabled ? certExpiry.warnDays : DEFAULT_CERT_WARN_DAYS
  const color = days < 0 ? 'var(--m3-down)' : days <= warnDays ? 'var(--m3-degraded)' : 'var(--m3-secondary)'
  return (
    <div className="font-mono text-xs mt-0.5" style={{ color }} title={`TLS certificate expires ${new Date(expiresAt).toLocaleString()}`}>
      {days < 0 ? 'TLS certificate expired' : `TLS certificate: ${days} ${days === 1 ? 'day' : 'days'} left`}
    </div>
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
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true" className={spinning ? 'animate-spin' : undefined}>
      <path d="M1 7a6 6 0 106-6 6 6 0 00-4.5 2L1 4.5" />
      <path d="M1 1v3.5H4.5" />
    </svg>
  )
}

function IconEdit() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.5 2.5l2 2L4 12H2v-2L9.5 2.5z" />
    </svg>
  )
}

function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 3.5h10M5 3.5V2h4v1.5M5.5 6v4.5M8.5 6v4.5M3 3.5l.7 8h6.6l.7-8" />
    </svg>
  )
}
