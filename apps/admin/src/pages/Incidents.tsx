import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Incident, Monitor } from '@bsp/shared'

const impactColors: Record<string, string> = {
  none: 'bg-slate-500/15 text-slate-400',
  minor: 'bg-yellow-500/15 text-yellow-400',
  major: 'bg-orange-500/15 text-orange-400',
  critical: 'bg-red-500/15 text-red-400',
}

const statusColors: Record<string, string> = {
  investigating: 'bg-red-500/15 text-red-400',
  identified: 'bg-orange-500/15 text-orange-400',
  monitoring: 'bg-yellow-500/15 text-yellow-400',
  resolved: 'bg-emerald-500/15 text-emerald-400',
}

export default function IncidentsPage() {
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [updateBody, setUpdateBody] = useState('')
  const [updateStatus, setUpdateStatus] = useState('monitoring')

  const { data: incidents = [] } = useQuery<Incident[]>({
    queryKey: ['incidents'],
    queryFn: () => api.get('/admin/incidents'),
  })

  const { data: monitors = [] } = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
  })

  const postUpdateMutation = useMutation({
    mutationFn: ({ id, body, status }: { id: number; body: string; status: string }) =>
      api.post(`/admin/incidents/${id}/updates`, { body, status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['incidents'] })
      setUpdateBody('')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/incidents/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['incidents'] }),
  })

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Incidents</h2>
          <p className="text-slate-400 text-sm mt-1">{incidents.filter((i) => i.status !== 'resolved').length} active</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          + Report Incident
        </button>
      </div>

      <div className="space-y-3">
        {incidents.map((incident) => (
          <div key={incident.id} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div
              className="px-5 py-4 flex items-center gap-3 cursor-pointer hover:bg-slate-800/50 transition-colors"
              onClick={() => setExpandedId(expandedId === incident.id ? null : incident.id)}
            >
              <span className="text-slate-500">{expandedId === incident.id ? '▾' : '▸'}</span>
              <div className="flex-1">
                <span className="text-white font-medium">{incident.title}</span>
                <div className="flex gap-2 mt-1">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[incident.status]}`}>
                    {incident.status}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${impactColors[incident.impact]}`}>
                    {incident.impact}
                  </span>
                </div>
              </div>
              <span className="text-xs text-slate-500">
                {new Date(incident.startedAt).toLocaleDateString()}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm(`Delete incident "${incident.title}"?`)) {
                    deleteMutation.mutate(incident.id)
                  }
                }}
                className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-red-500/10"
              >
                Delete
              </button>
            </div>

            {expandedId === incident.id && (
              <div className="px-5 pb-5 border-t border-slate-800 pt-4 space-y-4">
                {/* Affected monitors */}
                <div>
                  <p className="text-xs text-slate-400 mb-2">Affected monitors</p>
                  <div className="flex flex-wrap gap-2">
                    {(incident.monitorIds ?? []).map((mid) => {
                      const m = monitors.find((mon) => mon.id === mid)
                      return m ? (
                        <span key={mid} className="text-xs bg-slate-800 text-slate-300 px-2 py-0.5 rounded">
                          {m.name}
                        </span>
                      ) : null
                    })}
                    {(incident.monitorIds ?? []).length === 0 && (
                      <span className="text-xs text-slate-500">None linked</span>
                    )}
                  </div>
                </div>

                {/* Updates timeline */}
                {(incident.updates ?? []).length > 0 && (
                  <div className="space-y-3">
                    {(incident.updates ?? []).map((update) => (
                      <div key={update.id} className="border-l-2 border-slate-700 pl-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-xs px-1.5 py-0.5 rounded ${statusColors[update.status]}`}>
                            {update.status}
                          </span>
                          <span className="text-xs text-slate-500">
                            {new Date(update.postedAt).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-sm text-slate-300">{update.body}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Post update */}
                {incident.status !== 'resolved' && (
                  <div className="space-y-2">
                    <p className="text-xs text-slate-400">Post update</p>
                    <textarea
                      value={updateBody}
                      onChange={(e) => setUpdateBody(e.target.value)}
                      rows={3}
                      placeholder="Describe the current situation…"
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500 resize-none"
                    />
                    <div className="flex items-center gap-3">
                      <select
                        value={updateStatus}
                        onChange={(e) => setUpdateStatus(e.target.value)}
                        className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm"
                      >
                        <option value="investigating">Investigating</option>
                        <option value="identified">Identified</option>
                        <option value="monitoring">Monitoring</option>
                        <option value="resolved">Resolved</option>
                      </select>
                      <button
                        onClick={() => {
                          if (!updateBody.trim()) return
                          postUpdateMutation.mutate({ id: incident.id, body: updateBody, status: updateStatus })
                        }}
                        className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-4 py-2 rounded-lg transition-colors"
                      >
                        Post Update
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {incidents.length === 0 && (
          <div className="text-slate-500 text-sm text-center py-12">No incidents. All systems operational.</div>
        )}
      </div>

      {showCreate && (
        <CreateIncidentModal
          monitors={monitors}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['incidents'] })
            setShowCreate(false)
          }}
        />
      )}
    </div>
  )
}

function CreateIncidentModal({ monitors, onClose, onSaved }: { monitors: Monitor[]; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState('investigating')
  const [impact, setImpact] = useState('minor')
  const [selectedMonitors, setSelectedMonitors] = useState<number[]>([])
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const incident = await api.post<Incident>('/admin/incidents', { title, status, impact })
      if (selectedMonitors.length > 0) {
        await api.post(`/admin/incidents/${incident.id}/monitors`, { monitorIds: selectedMonitors })
      }
      onSaved()
    } finally {
      setLoading(false)
    }
  }

  const inputCls = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md">
        <div className="flex items-center justify-between p-6 border-b border-slate-800">
          <h3 className="text-lg font-semibold text-white">Report Incident</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm text-slate-400 mb-1.5">Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} required className={inputCls} placeholder="Service degradation" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1.5">Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
                <option value="investigating">Investigating</option>
                <option value="identified">Identified</option>
                <option value="monitoring">Monitoring</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1.5">Impact</label>
              <select value={impact} onChange={(e) => setImpact(e.target.value)} className={inputCls}>
                <option value="none">None</option>
                <option value="minor">Minor</option>
                <option value="major">Major</option>
                <option value="critical">Critical</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm text-slate-400 mb-1.5">Affected Monitors</label>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {monitors.map((m) => (
                <label key={m.id} className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedMonitors.includes(m.id)}
                    onChange={(e) => {
                      setSelectedMonitors(e.target.checked
                        ? [...selectedMonitors, m.id]
                        : selectedMonitors.filter((id) => id !== m.id))
                    }}
                    className="accent-indigo-500"
                  />
                  {m.name}
                </label>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="text-sm text-slate-400 hover:text-white px-4 py-2">Cancel</button>
            <button type="submit" disabled={loading} className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50">
              {loading ? 'Creating…' : 'Create Incident'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
