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
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Monitors</h2>
          <p className="text-slate-400 text-sm mt-1">{monitors.length} monitor{monitors.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          + Add Monitor
        </button>
      </div>

      {isLoading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="text-left text-slate-400 font-medium px-4 py-3">Name</th>
                <th className="text-left text-slate-400 font-medium px-4 py-3">Type</th>
                <th className="text-left text-slate-400 font-medium px-4 py-3">Group</th>
                <th className="text-left text-slate-400 font-medium px-4 py-3">Interval</th>
                <th className="text-left text-slate-400 font-medium px-4 py-3">Status</th>
                <th className="text-left text-slate-400 font-medium px-4 py-3">Last Check</th>
                <th className="text-right text-slate-400 font-medium px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {monitors.map((monitor) => {
                const group = groups.find((g) => g.id === monitor.groupId)
                return (
                  <tr key={monitor.id} className="border-b border-slate-800/50 last:border-0">
                    <td className="px-4 py-3 text-white font-medium">{monitor.name}</td>
                    <td className="px-4 py-3">
                      <span className="bg-slate-800 text-slate-300 text-xs px-2 py-0.5 rounded uppercase tracking-wide">
                        {monitor.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-400">{group?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-slate-400">{monitor.intervalSecs}s</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={monitor.currentStatus} />
                    </td>
                    <td className="px-4 py-3 text-slate-400">
                      {monitor.lastCheckedAt
                        ? new Date(monitor.lastCheckedAt).toLocaleTimeString()
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => checkNowMutation.mutate(monitor.id)}
                          className="text-xs text-slate-400 hover:text-white transition-colors px-2 py-1 rounded hover:bg-slate-800"
                        >
                          Check now
                        </button>
                        <button
                          onClick={() => setEditingMonitor(monitor)}
                          className="text-xs text-slate-400 hover:text-white transition-colors px-2 py-1 rounded hover:bg-slate-800"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`Delete "${monitor.name}"?`)) {
                              deleteMutation.mutate(monitor.id)
                            }
                          }}
                          className="text-xs text-red-400 hover:text-red-300 transition-colors px-2 py-1 rounded hover:bg-red-500/10"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {monitors.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-slate-500">
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
