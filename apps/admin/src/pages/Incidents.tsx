import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Incident, Monitor } from '@bsp/shared'
import { ConfirmModal } from '../components/ConfirmModal'
import { NotifySubscribersCheckbox } from '../components/subscribers/NotifySubscribersCheckbox'
import { Modal } from '../components/ModalShell'
import { Alert, EmptyState, ErrorState, Field, LoadingState, PageContainer, PageHeader, useToast } from '../components/ui'

interface Tone { text: string; bar: string; bg: string }

const NEUTRAL: Tone = { text: 'var(--m3-secondary)', bar: 'var(--m3-outline)', bg: 'var(--m3-surface-container)' }
const DOWN: Tone = { text: 'var(--m3-down)', bar: 'var(--m3-down)', bg: 'var(--m3-down-bg)' }
const PARTIAL: Tone = { text: 'var(--m3-partial)', bar: 'var(--m3-partial-bar)', bg: 'var(--m3-partial-bg)' }
const DEGRADED: Tone = { text: 'var(--m3-degraded)', bar: 'var(--m3-degraded-bar)', bg: 'var(--m3-degraded-bg)' }
const UP: Tone = { text: 'var(--m3-up)', bar: 'var(--m3-up-bar)', bg: 'var(--m3-up-bg)' }

const statusTones: Record<string, Tone> = {
  investigating: DOWN,
  identified:    PARTIAL,
  monitoring:    DEGRADED,
  resolved:      UP,
}

const impactTones: Record<string, Tone> = {
  none:     NEUTRAL,
  minor:    DEGRADED,
  major:    PARTIAL,
  critical: DOWN,
}

function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className="text-xs px-2 py-0.5 rounded-full font-medium"
      style={{ background: tone.bg, color: tone.text, border: `1px solid color-mix(in srgb, ${tone.bar} 30%, transparent)` }}
    >
      {children}
    </span>
  )
}

export default function IncidentsPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const [showCreate, setShowCreate] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Incident | null>(null)
  const [updateBody, setUpdateBody] = useState('')
  const [updateStatus, setUpdateStatus] = useState('monitoring')
  const [updateNotify, setUpdateNotify] = useState(true)

  const { data: incidents = [], isPending, isError, refetch } = useQuery<Incident[]>({
    queryKey: ['incidents'],
    queryFn: () => api.get('/admin/incidents'),
  })

  const { data: monitors = [] } = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
  })

  const postUpdateMutation = useMutation({
    mutationFn: ({ id, body, status, notifySubscribers }: { id: number; body: string; status: string; notifySubscribers: boolean }) =>
      api.post(`/admin/incidents/${id}/updates`, { body, status, notifySubscribers }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['incidents'] })
      setUpdateBody('')
      setUpdateNotify(true)
      toast.success('Update posted')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (incident: Incident) => api.delete(`/admin/incidents/${incident.id}`),
    onSuccess: (_data, incident) => {
      qc.invalidateQueries({ queryKey: ['incidents'] })
      setConfirmDelete(null)
      toast.success(`Deleted "${incident.title}"`)
    },
    onError: (err) => toast.error(`Couldn't delete incident: ${(err as Error).message}`),
  })

  const activeCount = incidents.filter((i) => i.status !== 'resolved').length

  const newIncidentButton = (
    <button type="button" onClick={() => setShowCreate(true)} className="btn btn-primary">
      <span className="material-symbols-outlined" aria-hidden="true">add_circle</span>
      New Incident
    </button>
  )

  return (
    <PageContainer>
      <PageHeader
        title="Incidents"
        subtitle={isPending || isError ? undefined : `${activeCount} active · ${incidents.length} total`}
        actions={newIncidentButton}
      />

      {isPending ? (
        <LoadingState label="Loading incidents…" />
      ) : isError ? (
        <ErrorState message="Couldn't load incidents." onRetry={() => void refetch()} />
      ) : incidents.length === 0 ? (
        <EmptyState
          icon="warning"
          title="No incidents yet"
          description="Incidents you open will appear here with their update timeline."
        />
      ) : (
      <div className="space-y-2">
        {incidents.map((incident) => {
          const tone = statusTones[incident.status] ?? NEUTRAL
          const impactTone = impactTones[incident.impact] ?? NEUTRAL
          const isExpanded = expandedId === incident.id
          const panelId = `incident-${incident.id}-details`

          return (
            <div
              key={incident.id}
              className="rounded-2xl overflow-hidden"
              style={{ borderLeft: `3px solid ${tone.bar}` }}
            >
              {/* Header row */}
              <div className="flex items-center gap-2 pr-3 transition-colors hover:bg-surface-container">
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  aria-controls={panelId}
                  onClick={() => { setExpandedId(isExpanded ? null : incident.id); postUpdateMutation.reset() }}
                  className="flex-1 min-w-0 pl-5 py-4 flex items-center gap-3 text-left rounded-r-xl focus-ring"
                >
                  <span className="font-mono text-xs flex-shrink-0" aria-hidden="true" style={{ color: 'var(--m3-secondary)' }}>
                    {isExpanded ? '▾' : '▸'}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium text-sm" style={{ color: 'var(--m3-on-surface)' }}>
                      {incident.title}
                    </span>
                    <span className="flex gap-2 mt-1.5 flex-wrap">
                      <Chip tone={tone}>{incident.status}</Chip>
                      <Chip tone={impactTone}>{incident.impact}</Chip>
                    </span>
                  </span>
                  <span className="font-mono text-xs flex-shrink-0" style={{ color: 'var(--m3-secondary)' }}>
                    {new Date(incident.startedAt).toLocaleDateString()}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(incident)}
                  title="Delete"
                  aria-label={`Delete ${incident.title}`}
                  className="btn-icon hover:!bg-[var(--m3-down-bg)]"
                  style={{ color: 'var(--m3-down)' }}
                >
                  <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>delete</span>
                </button>
              </div>

              {/* Expanded panel */}
              {isExpanded && (
                <div id={panelId} className="px-5 pb-5 pt-4 space-y-4" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>

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
                          const updateTone = statusTones[update.status] ?? NEUTRAL
                          return (
                            <div key={update.id} className="flex gap-3">
                              <div className="flex flex-col items-center flex-shrink-0">
                                <div
                                  className="w-2 h-2 rounded-full flex-shrink-0 mt-0.5"
                                  style={{ background: i === 0 ? updateTone.bar : 'var(--m3-outline-variant)' }}
                                />
                                {i < (incident.updates ?? []).length - 1 && (
                                  <div className="w-px flex-1 mt-1" style={{ background: 'var(--m3-outline-variant)', minHeight: 16 }} />
                                )}
                              </div>
                              <div className="flex-1 min-w-0 pb-1">
                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                  <span className="text-xs font-medium" style={{ color: i === 0 ? updateTone.text : 'var(--m3-secondary)' }}>
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
                      <Field label="Post Update">
                        <textarea
                          value={updateBody}
                          onChange={(e) => setUpdateBody(e.target.value)}
                          rows={3}
                          placeholder="Describe the current situation…"
                          className="input-sig resize-none"
                        />
                      </Field>
                      <div className="flex flex-wrap items-center gap-3">
                        <select
                          value={updateStatus}
                          onChange={(e) => setUpdateStatus(e.target.value)}
                          aria-label="New status"
                          className="input-sig"
                          style={{ width: 'auto' }}
                        >
                          <option value="investigating">Investigating</option>
                          <option value="identified">Identified</option>
                          <option value="monitoring">Monitoring</option>
                          <option value="resolved">Resolved</option>
                        </select>
                        <button
                          type="button"
                          onClick={() => {
                            if (!updateBody.trim()) return
                            postUpdateMutation.mutate({ id: incident.id, body: updateBody, status: updateStatus, notifySubscribers: updateNotify })
                          }}
                          disabled={postUpdateMutation.isPending || !updateBody.trim()}
                          className="btn btn-primary"
                        >
                          Post Update
                        </button>
                        <NotifySubscribersCheckbox checked={updateNotify} onChange={setUpdateNotify} />
                      </div>
                      {postUpdateMutation.isError && (
                        <Alert tone="error">
                          {postUpdateMutation.error instanceof Error && postUpdateMutation.error.message
                            ? postUpdateMutation.error.message
                            : 'Failed to post the update. Please try again.'}
                        </Alert>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      )}

      {showCreate && (
        <CreateIncidentModal
          monitors={monitors}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['incidents'] })
            setShowCreate(false)
            toast.success('Incident created')
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete incident"
          message={`Delete "${confirmDelete.title}"? This cannot be undone.`}
          pending={deleteMutation.isPending}
          pendingLabel="Deleting…"
          onConfirm={() => deleteMutation.mutate(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </PageContainer>
  )
}

function CreateIncidentModal({ monitors, onClose, onSaved }: { monitors: Monitor[]; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState('investigating')
  const [impact, setImpact] = useState('minor')
  const [selectedMonitors, setSelectedMonitors] = useState<number[]>([])
  const [notifySubscribers, setNotifySubscribers] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      // Monitors go in the same request so component-scoped subscribers are matched.
      await api.post<Incident>('/admin/incidents', { title, status, impact, monitorIds: selectedMonitors, notifySubscribers })
      onSaved()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Failed to create the incident. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal title="New Incident" icon="warning" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Title" required>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            className="input-sig"
            placeholder="Service degradation"
          />
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="input-sig">
              <option value="investigating">Investigating</option>
              <option value="identified">Identified</option>
              <option value="monitoring">Monitoring</option>
            </select>
          </Field>
          <Field label="Impact">
            <select value={impact} onChange={(e) => setImpact(e.target.value)} className="input-sig">
              <option value="none">None</option>
              <option value="minor">Minor</option>
              <option value="major">Major</option>
              <option value="critical">Critical</option>
            </select>
          </Field>
        </div>

        <fieldset>
          <legend className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>
            Affected Monitors
          </legend>
          <div
            className="space-y-1 max-h-36 overflow-y-auto rounded-lg p-2"
            style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}
          >
            {monitors.map((m) => (
              <label key={m.id} className="flex items-center gap-2.5 text-sm cursor-pointer px-2 py-1.5 rounded-md transition-colors hover:bg-surface-container-high">
                <input
                  type="checkbox"
                  checked={selectedMonitors.includes(m.id)}
                  onChange={(e) => {
                    setSelectedMonitors(e.target.checked
                      ? [...selectedMonitors, m.id]
                      : selectedMonitors.filter((id) => id !== m.id))
                  }}
                />
                <span style={{ color: 'var(--m3-on-surface)' }}>{m.name}</span>
              </label>
            ))}
            {monitors.length === 0 && (
              <p className="text-xs px-2 py-2" style={{ color: 'var(--m3-secondary)' }}>No monitors available</p>
            )}
          </div>
        </fieldset>

        <NotifySubscribersCheckbox checked={notifySubscribers} onChange={setNotifySubscribers} />

        {error && <Alert tone="error">{error}</Alert>}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={loading} className="btn btn-primary">
            {loading ? 'Creating…' : 'Create Incident'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
