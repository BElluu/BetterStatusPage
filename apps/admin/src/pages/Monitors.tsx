import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Monitor } from '@bsp/shared'
import { StatusBadge } from '../components/monitors/StatusBadge'
import MonitorFormModal from '../components/monitors/MonitorFormModal'
import { ConfirmModal } from '../components/ConfirmModal'

type SortCol = 'name' | 'type' | 'intervalSecs' | 'currentStatus' | 'lastCheckedAt'

const COLS: Array<{ label: string; key: SortCol | null }> = [
  { label: 'Name', key: 'name' },
  { label: 'Type', key: 'type' },
  { label: 'Interval', key: 'intervalSecs' },
  { label: 'Status', key: 'currentStatus' },
  { label: 'Last Check', key: 'lastCheckedAt' },
  { label: '', key: null },
]

export default function MonitorsPage() {
  const qc = useQueryClient()
  const [editingMonitor, setEditingMonitor] = useState<Monitor | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<Monitor | null>(null)
  const [sortCol, setSortCol] = useState<SortCol>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [activeTags, setActiveTags] = useState<string[]>([])

  const { data: monitors = [], isLoading } = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
    refetchInterval: 15_000,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/monitors/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['monitors'] }),
  })

  const checkNowMutation = useMutation({
    mutationFn: (id: number) => api.post(`/admin/monitors/${id}/check-now`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['monitors'] }),
  })

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
    <div className="p-8 space-y-6 fade-up">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-headline font-bold text-2xl" style={{ color: 'var(--m3-on-surface)' }}>Monitors</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>
            {monitors.length} monitor{monitors.length !== 1 ? 's' : ''} · 15s refresh
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="text-sm font-semibold px-4 py-2.5 rounded-lg transition-all"
          style={{ background: 'var(--m3-primary)', color: 'var(--m3-on-primary)' }}
        >
          + Add Monitor
        </button>
      </div>

      {/* Tag filter bar */}
      {allTags.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Filter:</span>
          {allTags.map((t) => {
            const active = activeTags.includes(t.label)
            return (
              <button key={t.label}
                onClick={() => setActiveTags((prev) => active ? prev.filter((l) => l !== t.label) : [...prev, t.label])}
                className="text-xs px-2.5 py-1 rounded-full font-medium transition-all"
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
            <button onClick={() => setActiveTags([])}
              className="text-xs px-2 py-1 rounded"
              style={{ color: 'var(--m3-secondary)' }}
            >Clear</button>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="text-sm" style={{ color: 'var(--m3-secondary)' }}>Loading…</div>
      ) : (
        <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
                {COLS.map(({ label, key }) => (
                  <th
                    key={label}
                    className={`px-4 py-3 font-mono text-xs uppercase tracking-wider ${label === '' ? 'text-right' : 'text-left'}`}
                    style={{
                      color: key && sortCol === key ? 'var(--m3-primary)' : 'var(--m3-secondary)',
                      background: 'var(--m3-surface-container)',
                      cursor: key ? 'pointer' : 'default',
                      userSelect: 'none',
                      whiteSpace: 'nowrap',
                    }}
                    onClick={() => key && toggleSort(key)}
                  >
                    {label}
                    {key && sortCol === key && (
                      <span className="ml-1 inline-block" style={{ fontSize: '10px' }}>
                        {sortDir === 'asc' ? '↑' : '↓'}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map((monitor, i) => (
                <tr
                  key={monitor.id}
                  className="transition-colors"
                  style={{ borderTop: i > 0 ? '1px solid var(--m3-outline-variant)' : 'none' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--m3-surface-container)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium" style={{ color: 'var(--m3-on-surface)' }}>{monitor.name}</div>
                    {(monitor.tags ?? []).length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {(monitor.tags ?? []).map((t, j) => {
                          const active = activeTags.includes(t.label)
                          return (
                            <button key={j} type="button"
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
                        <ActionBtn onClick={() => checkNowMutation.mutate(monitor.id)} title="Check now">
                          <IconRefresh />
                        </ActionBtn>
                      )}
                      <ActionBtn onClick={() => setEditingMonitor(monitor)} title="Edit">
                        <IconEdit />
                      </ActionBtn>
                      <ActionBtn onClick={() => setConfirmDelete(monitor)} title="Delete" danger>
                        <IconTrash />
                      </ActionBtn>
                    </div>
                  </td>
                </tr>
              ))}
              {displayed.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-sm" style={{ color: 'var(--m3-secondary)' }}>
                    {monitors.length === 0 ? 'No monitors yet. Click "+ Add Monitor" to create one.' : 'No monitors match the selected tags.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {(showCreate || editingMonitor) && (
        <MonitorFormModal
          monitor={editingMonitor}
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
          onConfirm={() => { deleteMutation.mutate(confirmDelete.id); setConfirmDelete(null) }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}

function ActionBtn({ children, onClick, title, danger = false }: {
  children: React.ReactNode; onClick: () => void; title: string; danger?: boolean
}) {
  return (
    <button onClick={onClick} title={title}
      className="p-1.5 rounded-md transition-all"
      style={{ color: danger ? 'var(--m3-down)' : 'var(--m3-secondary)' }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.background = danger ? 'var(--m3-down-bg)' : 'var(--m3-surface-container-high)'
        ;(e.currentTarget as HTMLButtonElement).style.color = danger ? 'var(--m3-down)' : 'var(--m3-on-surface)'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.background = ''
        ;(e.currentTarget as HTMLButtonElement).style.color = danger ? 'var(--m3-down)' : 'var(--m3-secondary)'
      }}
    >
      {children}
    </button>
  )
}

function IconRefresh() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M1 7a6 6 0 106-6 6 6 0 00-4.5 2L1 4.5" />
      <path d="M1 1v3.5H4.5" />
    </svg>
  )
}

function IconEdit() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 2.5l2 2L4 12H2v-2L9.5 2.5z" />
    </svg>
  )
}

function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3.5h10M5 3.5V2h4v1.5M5.5 6v4.5M8.5 6v4.5M3 3.5l.7 8h6.6l.7-8" />
    </svg>
  )
}
