import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Monitor, MonitorGroup } from '@bsp/shared'
import { StatusBadge } from '../components/monitors/StatusBadge'
import MonitorFormModal from '../components/monitors/MonitorFormModal'

export default function MonitorsPage() {
  const qc = useQueryClient()
  const [editingMonitor, setEditingMonitor] = useState<Monitor | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const { data: monitors = [], isLoading } = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
    refetchInterval: 15_000,
  })

  const { data: groups = [] } = useQuery<MonitorGroup[]>({
    queryKey: ['groups'],
    queryFn: () => api.get('/admin/groups'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/monitors/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['monitors'] }),
  })

  const checkNowMutation = useMutation({
    mutationFn: (id: number) => api.post(`/admin/monitors/${id}/check-now`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['monitors'] }),
  })

  return (
    <div className="p-8 space-y-6 fade-up">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display font-bold text-2xl" style={{ color: 'var(--sig-text)' }}>Monitors</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--sig-text-muted)' }}>
            {monitors.length} monitor{monitors.length !== 1 ? 's' : ''} · 15s refresh
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="text-sm font-semibold px-4 py-2.5 rounded-lg transition-all"
          style={{
            background: 'linear-gradient(135deg, #00d4af 0%, #00a88a 100%)',
            color: '#080d18',
          }}
        >
          + Add Monitor
        </button>
      </div>

      {isLoading ? (
        <div className="text-sm" style={{ color: 'var(--sig-text-muted)' }}>Loading…</div>
      ) : (
        <div className="glass rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--sig-border)' }}>
                {['Name', 'Type', 'Group', 'Interval', 'Status', 'Last Check', ''].map((h) => (
                  <th
                    key={h}
                    className={`px-4 py-3 font-mono text-xs uppercase tracking-wider ${h === '' ? 'text-right' : 'text-left'}`}
                    style={{ color: 'var(--sig-text-muted)' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {monitors.map((monitor, i) => {
                const group = groups.find((g) => g.id === monitor.groupId)
                return (
                  <tr
                    key={monitor.id}
                    className="glass-hover"
                    style={{ borderTop: i > 0 ? '1px solid var(--sig-border)' : 'none' }}
                  >
                    <td className="px-4 py-3 font-medium" style={{ color: 'var(--sig-text)' }}>
                      {monitor.name}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="font-mono text-xs uppercase px-1.5 py-0.5 rounded"
                        style={{ color: 'var(--sig-text-muted)', background: 'rgba(255,255,255,0.05)' }}
                      >
                        {monitor.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm" style={{ color: 'var(--sig-text-muted)' }}>
                      {group?.name ?? '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--sig-text-muted)' }}>
                      {monitor.intervalSecs}s
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={monitor.currentStatus} />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--sig-text-muted)' }}>
                      {monitor.lastCheckedAt
                        ? new Date(monitor.lastCheckedAt).toLocaleTimeString()
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <ActionBtn
                          onClick={() => checkNowMutation.mutate(monitor.id)}
                          title="Check now"
                        >
                          <IconRefresh />
                        </ActionBtn>
                        <ActionBtn
                          onClick={() => setEditingMonitor(monitor)}
                          title="Edit"
                        >
                          <IconEdit />
                        </ActionBtn>
                        <ActionBtn
                          onClick={() => {
                            if (confirm(`Delete "${monitor.name}"?`)) {
                              deleteMutation.mutate(monitor.id)
                            }
                          }}
                          title="Delete"
                          danger
                        >
                          <IconTrash />
                        </ActionBtn>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {monitors.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm" style={{ color: 'var(--sig-text-muted)' }}>
                    No monitors yet. Click "+ Add Monitor" to create one.
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
          groups={groups}
          onClose={() => { setShowCreate(false); setEditingMonitor(null) }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['monitors'] })
            setShowCreate(false)
            setEditingMonitor(null)
          }}
        />
      )}
    </div>
  )
}

function ActionBtn({
  children,
  onClick,
  title,
  danger = false,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="p-1.5 rounded-md transition-all"
      style={{ color: danger ? 'var(--sig-red)' : 'var(--sig-text-muted)' }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.background = danger ? 'rgba(255,77,106,0.1)' : 'rgba(255,255,255,0.06)'
        ;(e.currentTarget as HTMLButtonElement).style.color = danger ? 'var(--sig-red)' : 'var(--sig-text)'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.background = ''
        ;(e.currentTarget as HTMLButtonElement).style.color = danger ? 'var(--sig-red)' : 'var(--sig-text-muted)'
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
