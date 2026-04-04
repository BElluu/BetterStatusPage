import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Incident, Monitor } from '@bsp/shared'

const statusColors: Record<string, string> = {
  investigating: '#ff4d6a',
  identified:    '#f97316',
  monitoring:    '#f5a623',
  resolved:      '#00d4af',
}

const impactColors: Record<string, string> = {
  none:     '#5a6a8a',
  minor:    '#f5a623',
  major:    '#f97316',
  critical: '#ff4d6a',
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

  const activeCount = incidents.filter((i) => i.status !== 'resolved').length

  return (
    <div className="p-8 space-y-6 fade-up">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-headline font-bold text-2xl" style={{ color: 'var(--m3-on-surface)' }}>Incidents</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>
            {activeCount} active · {incidents.length} total
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 py-3 px-4 rounded-xl font-headline font-bold text-sm transition-all active:scale-[0.98]"
          style={{ background: 'var(--m3-on-surface)', color: 'var(--m3-surface)' }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>add_circle</span>
          New Incident
        </button>
      </div>

      <div className="space-y-2">
        {incidents.map((incident) => {
          const color = statusColors[incident.status] ?? '#5a6a8a'
          const iColor = impactColors[incident.impact] ?? '#5a6a8a'
          const isExpanded = expandedId === incident.id

          return (
            <div
              key={incident.id}
              className="rounded-2xl overflow-hidden"
              style={{ borderLeft: `3px solid ${color}` }}
            >
              {/* Header row */}
              <div
                className="px-5 py-4 flex items-center gap-3 cursor-pointer transition-colors"
                onClick={() => setExpandedId(isExpanded ? null : incident.id)}
                onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.background = 'var(--m3-surface-container)')}
                onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.background = '')}
              >
                <span className="font-mono text-xs flex-shrink-0" style={{ color: 'var(--m3-secondary)' }}>
                  {isExpanded ? '▾' : '▸'}
                </span>
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-sm" style={{ color: 'var(--m3-on-surface)' }}>
                    {incident.title}
                  </span>
                  <div className="flex gap-2 mt-1.5 flex-wrap">
                    <span
                      className="text-xs px-2 py-0.5 rounded-full font-medium"
                      style={{ background: `${color}15`, color, border: `1px solid ${color}25` }}
                    >
                      {incident.status}
                    </span>
                    <span
                      className="text-xs px-2 py-0.5 rounded-full font-medium"
                      style={{ background: `${iColor}12`, color: iColor, border: `1px solid ${iColor}20` }}
                    >
                      {incident.impact}
                    </span>
                  </div>
                </div>
                <span className="font-mono text-xs flex-shrink-0" style={{ color: 'var(--m3-secondary)' }}>
                  {new Date(incident.startedAt).toLocaleDateString()}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirm(`Delete incident "${incident.title}"?`)) {
                      deleteMutation.mutate(incident.id)
                    }
                  }}
                  className="text-xs px-2 py-1 rounded transition-colors flex-shrink-0"
                  style={{ color: 'var(--m3-down)' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--m3-down-bg)')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = '')}
                >
                  Delete
                </button>
              </div>

              {/* Expanded panel */}
              {isExpanded && (
                <div className="px-5 pb-5 pt-4 space-y-4" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>

                  {/* Affected monitors */}
                  <div>
                    <p className="font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>
                      Affected Monitors
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {(incident.monitorIds ?? []).map((mid) => {
                        const m = monitors.find((mon) => mon.id === mid)
                        return m ? (
                          <span
                            key={mid}
                            className="text-xs px-2 py-0.5 rounded-full font-mono"
                            style={{
                              background: 'var(--m3-surface-container)',
                              color: 'var(--m3-secondary)',
                              border: '1px solid var(--m3-outline-variant)',
                            }}
                          >
                            {m.name}
                          </span>
                        ) : null
                      })}
                      {(incident.monitorIds ?? []).length === 0 && (
                        <span className="text-xs" style={{ color: 'var(--m3-secondary)' }}>None linked</span>
                      )}
                    </div>
                  </div>

                  {/* Updates timeline */}
                  {(incident.updates ?? []).length > 0 && (
                    <div className="space-y-3">
                      <p className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>
                        Updates
                      </p>
                      <div className="space-y-3">
                        {(incident.updates ?? []).map((update, i) => {
                          const uc = statusColors[update.status] ?? '#5a6a8a'
                          return (
                            <div key={update.id} className="flex gap-3">
                              <div className="flex flex-col items-center flex-shrink-0">
                                <div
                                  className="w-2 h-2 rounded-full flex-shrink-0 mt-0.5"
                                  style={{ background: i === 0 ? uc : 'var(--m3-outline-variant)' }}
                                />
                                {i < (incident.updates ?? []).length - 1 && (
                                  <div className="w-px flex-1 mt-1" style={{ background: 'var(--m3-outline-variant)', minHeight: 16 }} />
                                )}
                              </div>
                              <div className="flex-1 min-w-0 pb-1">
                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                  <span className="text-xs font-medium" style={{ color: i === 0 ? uc : 'var(--m3-secondary)' }}>
                                    {update.status}
                                  </span>
                                  <span className="font-mono text-xs" style={{ color: 'var(--m3-secondary)' }}>
                                    {new Date(update.postedAt).toLocaleString()}
                                  </span>
                                </div>
                                <p className="text-sm" style={{ color: 'var(--m3-on-surface)' }}>{update.body}</p>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Post update */}
                  {incident.status !== 'resolved' && (
                    <div className="space-y-3">
                      <p className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>
                        Post Update
                      </p>
                      <textarea
                        value={updateBody}
                        onChange={(e) => setUpdateBody(e.target.value)}
                        rows={3}
                        placeholder="Describe the current situation…"
                        className="input-sig resize-none"
                      />
                      <div className="flex items-center gap-3">
                        <select
                          value={updateStatus}
                          onChange={(e) => setUpdateStatus(e.target.value)}
                          className="input-sig"
                          style={{ width: 'auto' }}
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
                          className="text-sm font-semibold px-4 py-2 rounded-lg transition-all"
                          style={{
                            background: 'var(--m3-primary)',
                            color: 'var(--m3-on-primary)',
                          }}
                        >
                          Post Update
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {incidents.length === 0 && (
          <div className="text-center py-14 text-sm" style={{ color: 'var(--m3-secondary)' }}>
            No incidents reported. All systems operational.
          </div>
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

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.55)', overflowY: 'auto' }}>
      <div style={{ display: 'flex', minHeight: '100%', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div className="rounded-2xl w-full max-w-md" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
        <div className="flex items-center justify-between px-6 py-5" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
          <h3 className="font-headline font-bold text-lg" style={{ color: 'var(--m3-on-surface)' }}>New Incident</h3>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-xl leading-none transition-colors"
            style={{ color: 'var(--m3-secondary)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--m3-surface-container-high)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-on-surface)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = ''; (e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-secondary)' }}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>
              Title
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              className="input-sig"
              placeholder="Service degradation"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>
                Status
              </label>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className="input-sig">
                <option value="investigating">Investigating</option>
                <option value="identified">Identified</option>
                <option value="monitoring">Monitoring</option>
              </select>
            </div>
            <div>
              <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>
                Impact
              </label>
              <select value={impact} onChange={(e) => setImpact(e.target.value)} className="input-sig">
                <option value="none">None</option>
                <option value="minor">Minor</option>
                <option value="major">Major</option>
                <option value="critical">Critical</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>
              Affected Monitors
            </label>
            <div
              className="space-y-1 max-h-36 overflow-y-auto rounded-lg p-2"
              style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}
            >
              {monitors.map((m) => (
                <label key={m.id} className="flex items-center gap-2.5 text-sm cursor-pointer px-2 py-1.5 rounded-md transition-colors"
                  onMouseEnter={(e) => ((e.currentTarget as HTMLLabelElement).style.background = 'var(--m3-surface-container)')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLLabelElement).style.background = '')}
                >
                  <input
                    type="checkbox"
                    checked={selectedMonitors.includes(m.id)}
                    onChange={(e) => {
                      setSelectedMonitors(e.target.checked
                        ? [...selectedMonitors, m.id]
                        : selectedMonitors.filter((id) => id !== m.id))
                    }}
                    style={{ accentColor: 'var(--m3-primary)' }}
                  />
                  <span style={{ color: 'var(--m3-on-surface)' }}>{m.name}</span>
                </label>
              ))}
              {monitors.length === 0 && (
                <p className="text-xs px-2 py-2" style={{ color: 'var(--m3-secondary)' }}>No monitors available</p>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="text-sm px-4 py-2 rounded-lg transition-colors"
              style={{ color: 'var(--m3-secondary)' }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-on-surface)')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-secondary)')}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="text-sm font-semibold px-4 py-2 rounded-lg transition-all"
              style={{
                background: loading ? 'var(--m3-surface-container-high)' : 'var(--m3-primary)',
                color: loading ? 'var(--m3-secondary)' : 'var(--m3-on-primary)',
                opacity: loading ? 0.7 : 1,
              }}
            >
              {loading ? 'Creating…' : 'Create Incident'}
            </button>
          </div>
        </form>
      </div>
      </div>
    </div>,
    document.body,
  )
}
