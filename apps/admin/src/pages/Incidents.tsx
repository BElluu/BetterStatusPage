import { useState } from 'react'
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
          <h1 className="font-display font-bold text-2xl" style={{ color: 'var(--sig-text)' }}>Incidents</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--sig-text-muted)' }}>
            {activeCount} active · {incidents.length} total
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="text-sm font-semibold px-4 py-2.5 rounded-lg transition-all"
          style={{
            background: 'rgba(255,77,106,0.12)',
            color: 'var(--sig-red)',
            border: '1px solid rgba(255,77,106,0.25)',
          }}
        >
          + Report Incident
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
              className="glass rounded-xl overflow-hidden"
              style={{ borderLeft: `3px solid ${color}` }}
            >
              {/* Header row */}
              <div
                className="px-5 py-4 flex items-center gap-3 cursor-pointer transition-colors"
                onClick={() => setExpandedId(isExpanded ? null : incident.id)}
                onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.02)')}
                onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.background = '')}
              >
                <span className="font-mono text-xs flex-shrink-0" style={{ color: 'var(--sig-text-muted)' }}>
                  {isExpanded ? '▾' : '▸'}
                </span>
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-sm" style={{ color: 'var(--sig-text)' }}>
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
                <span className="font-mono text-xs flex-shrink-0" style={{ color: 'var(--sig-text-muted)' }}>
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
                  style={{ color: 'var(--sig-red)' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,77,106,0.1)')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = '')}
                >
                  Delete
                </button>
              </div>

              {/* Expanded panel */}
              {isExpanded && (
                <div className="px-5 pb-5 pt-4 space-y-4" style={{ borderTop: '1px solid var(--sig-border)' }}>

                  {/* Affected monitors */}
                  <div>
                    <p className="font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--sig-text-muted)' }}>
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
                              background: 'rgba(255,255,255,0.05)',
                              color: 'var(--sig-text-muted)',
                              border: '1px solid var(--sig-border)',
                            }}
                          >
                            {m.name}
                          </span>
                        ) : null
                      })}
                      {(incident.monitorIds ?? []).length === 0 && (
                        <span className="text-xs" style={{ color: 'var(--sig-text-muted)' }}>None linked</span>
                      )}
                    </div>
                  </div>

                  {/* Updates timeline */}
                  {(incident.updates ?? []).length > 0 && (
                    <div className="space-y-3">
                      <p className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--sig-text-muted)' }}>
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
                                  style={{ background: i === 0 ? uc : 'rgba(255,255,255,0.12)' }}
                                />
                                {i < (incident.updates ?? []).length - 1 && (
                                  <div className="w-px flex-1 mt-1" style={{ background: 'var(--sig-border)', minHeight: 16 }} />
                                )}
                              </div>
                              <div className="flex-1 min-w-0 pb-1">
                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                  <span className="text-xs font-medium" style={{ color: i === 0 ? uc : 'var(--sig-text-muted)' }}>
                                    {update.status}
                                  </span>
                                  <span className="font-mono text-xs" style={{ color: 'var(--sig-text-muted)' }}>
                                    {new Date(update.postedAt).toLocaleString()}
                                  </span>
                                </div>
                                <p className="text-sm" style={{ color: 'var(--sig-text)' }}>{update.body}</p>
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
                      <p className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--sig-text-muted)' }}>
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
                            background: 'linear-gradient(135deg, #00d4af 0%, #00a88a 100%)',
                            color: '#080d18',
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
          <div className="text-center py-14 text-sm" style={{ color: 'var(--sig-text-muted)' }}>
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="glass rounded-2xl w-full max-w-md" style={{ background: 'rgba(13,21,38,0.95)' }}>
        <div className="flex items-center justify-between px-6 py-5" style={{ borderBottom: '1px solid var(--sig-border)' }}>
          <h3 className="font-display font-bold text-lg" style={{ color: 'var(--sig-text)' }}>Report Incident</h3>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-xl leading-none transition-colors"
            style={{ color: 'var(--sig-text-muted)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--sig-text)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = ''; (e.currentTarget as HTMLButtonElement).style.color = 'var(--sig-text-muted)' }}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--sig-text-muted)' }}>
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
              <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--sig-text-muted)' }}>
                Status
              </label>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className="input-sig">
                <option value="investigating">Investigating</option>
                <option value="identified">Identified</option>
                <option value="monitoring">Monitoring</option>
              </select>
            </div>
            <div>
              <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--sig-text-muted)' }}>
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
            <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--sig-text-muted)' }}>
              Affected Monitors
            </label>
            <div
              className="space-y-1 max-h-36 overflow-y-auto rounded-lg p-2"
              style={{ background: 'rgba(8,13,24,0.6)', border: '1px solid var(--sig-border)' }}
            >
              {monitors.map((m) => (
                <label key={m.id} className="flex items-center gap-2.5 text-sm cursor-pointer px-2 py-1.5 rounded-md transition-colors"
                  onMouseEnter={(e) => ((e.currentTarget as HTMLLabelElement).style.background = 'rgba(255,255,255,0.04)')}
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
                    style={{ accentColor: 'var(--sig-teal)' }}
                  />
                  <span style={{ color: 'var(--sig-text)' }}>{m.name}</span>
                </label>
              ))}
              {monitors.length === 0 && (
                <p className="text-xs px-2 py-2" style={{ color: 'var(--sig-text-muted)' }}>No monitors available</p>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="text-sm px-4 py-2 rounded-lg transition-colors"
              style={{ color: 'var(--sig-text-muted)' }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--sig-text)')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--sig-text-muted)')}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="text-sm font-semibold px-4 py-2 rounded-lg transition-all"
              style={{
                background: loading ? 'rgba(0,212,175,0.3)' : 'linear-gradient(135deg, #00d4af 0%, #00a88a 100%)',
                color: loading ? 'rgba(0,0,0,0.5)' : '#080d18',
                opacity: loading ? 0.7 : 1,
              }}
            >
              {loading ? 'Creating…' : 'Create Incident'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
