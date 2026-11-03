import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Incident, IncidentTemplate, Monitor } from '@bsp/shared'
import { IncidentTemplatesModal, TEMPLATES_KEY } from '../components/incidents/IncidentTemplatesModal'
import { ConfirmModal } from '@better-forge/ui'
import { NotifySubscribersCheckbox } from '../components/subscribers/NotifySubscribersCheckbox'
import { Modal, ModalFooter } from '@better-forge/ui'
import { Alert, EmptyState, ErrorState, Field, LoadingState, PageContainer, PageHeader, useToast } from '@better-forge/ui'
import { formatDate, formatDateTime } from '@better-forge/ui'

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
  const [showTemplates, setShowTemplates] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [editIncident, setEditIncident] = useState<Incident | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Incident | null>(null)
  const [editing, setEditing] = useState<{ incidentId: number; id: number; body: string } | null>(null)
  const [confirmDeleteUpdate, setConfirmDeleteUpdate] = useState<{ incidentId: number; id: number } | null>(null)
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

  const editUpdateMutation = useMutation({
    mutationFn: ({ incidentId, id, body }: { incidentId: number; id: number; body: string }) =>
      api.patch(`/admin/incidents/${incidentId}/updates/${id}`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['incidents'] })
      setEditing(null)
      toast.success('Update saved')
    },
    onError: (err) => toast.error(`Couldn't save the update: ${(err as Error).message}`),
  })

  const deleteUpdateMutation = useMutation({
    mutationFn: ({ incidentId, id }: { incidentId: number; id: number }) =>
      api.delete(`/admin/incidents/${incidentId}/updates/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['incidents'] })
      setConfirmDeleteUpdate(null)
      toast.success('Update deleted')
    },
    onError: (err) => toast.error(`Couldn't delete the update: ${(err as Error).message}`),
  })

  const publishMutation = useMutation({
    mutationFn: (incident: Incident) => api.patch(`/admin/incidents/${incident.id}`, { draft: false }),
    onSuccess: (_data, incident) => {
      qc.invalidateQueries({ queryKey: ['incidents'] })
      toast.success(`Published "${incident.title}"`)
    },
    onError: (err) => toast.error(`Couldn't publish incident: ${(err as Error).message}`),
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
    <>
      <button type="button" onClick={() => setShowTemplates(true)} className="btn btn-secondary">
        <span className="material-symbols-outlined" aria-hidden="true">article</span>
        Templates
      </button>
      <button type="button" onClick={() => setShowCreate(true)} className="btn btn-primary">
        <span className="material-symbols-outlined" aria-hidden="true">add_circle</span>
        New Incident
      </button>
    </>
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
                      {incident.draft && <Chip tone={NEUTRAL}>draft</Chip>}
                      {incident.autoMonitorId !== null && <Chip tone={NEUTRAL}>automatic</Chip>}
                    </span>
                  </span>
                  <span className="font-mono text-xs flex-shrink-0" style={{ color: 'var(--m3-secondary)' }}>
                    {formatDate(incident.startedAt)}
                  </span>
                </button>
                {incident.draft && (
                  <button
                    type="button"
                    onClick={() => publishMutation.mutate(incident)}
                    disabled={publishMutation.isPending}
                    className="btn btn-primary"
                    aria-label={`Publish ${incident.title}`}
                  >
                    Publish
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setEditIncident(incident)}
                  title="Edit"
                  aria-label={`Edit ${incident.title}`}
                  className="btn-icon"
                >
                  <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>edit</span>
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
                                    {formatDateTime(update.postedAt)}
                                  </span>
                                  {editing?.id !== update.id && (
                                    <span className="flex gap-1 ml-auto">
                                      <button
                                        type="button"
                                        onClick={() => setEditing({ incidentId: incident.id, id: update.id, body: update.body })}
                                        title="Edit"
                                        aria-label={`Edit the ${update.status} update`}
                                        className="btn-icon"
                                      >
                                        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px' }}>edit</span>
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setConfirmDeleteUpdate({ incidentId: incident.id, id: update.id })}
                                        title="Delete"
                                        aria-label={`Delete the ${update.status} update`}
                                        className="btn-icon hover:!bg-[var(--m3-down-bg)]"
                                        style={{ color: 'var(--m3-down)' }}
                                      >
                                        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px' }}>delete</span>
                                      </button>
                                    </span>
                                  )}
                                </div>
                                {editing?.id === update.id ? (
                                  <div className="space-y-2">
                                    <textarea
                                      value={editing.body}
                                      onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                                      rows={3}
                                      aria-label="Update text"
                                      className="input-sig resize-none"
                                    />
                                    <div className="flex gap-2">
                                      <button
                                        type="button"
                                        onClick={() => editUpdateMutation.mutate(editing)}
                                        disabled={editUpdateMutation.isPending || !editing.body.trim()}
                                        className="btn btn-primary"
                                      >
                                        Save
                                      </button>
                                      <button type="button" onClick={() => setEditing(null)} className="btn btn-secondary">Cancel</button>
                                    </div>
                                  </div>
                                ) : (
                                  <p className="text-sm" style={{ color: 'var(--m3-on-surface)' }}>{update.body}</p>
                                )}
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

      {editIncident && (
        <EditIncidentModal
          incident={editIncident}
          monitors={monitors}
          onClose={() => setEditIncident(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['incidents'] })
            setEditIncident(null)
            toast.success('Incident saved')
          }}
        />
      )}

      {showTemplates && <IncidentTemplatesModal onClose={() => setShowTemplates(false)} />}

      {confirmDeleteUpdate && (
        <ConfirmModal
          title="Delete update"
          message="Delete this update? It disappears from the status page too. The incident keeps its status."
          pending={deleteUpdateMutation.isPending}
          pendingLabel="Deleting…"
          onConfirm={() => deleteUpdateMutation.mutate(confirmDeleteUpdate)}
          onCancel={() => setConfirmDeleteUpdate(null)}
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

function MonitorPicker({ monitors, selected, onChange }: { monitors: Monitor[]; selected: number[]; onChange: (ids: number[]) => void }) {
  return (
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
              checked={selected.includes(m.id)}
              onChange={(e) => onChange(e.target.checked ? [...selected, m.id] : selected.filter((id) => id !== m.id))}
            />
            <span style={{ color: 'var(--m3-on-surface)' }}>{m.name}</span>
          </label>
        ))}
        {monitors.length === 0 && (
          <p className="text-xs px-2 py-2" style={{ color: 'var(--m3-secondary)' }}>No monitors available</p>
        )}
      </div>
    </fieldset>
  )
}

function EditIncidentModal({ incident, monitors, onClose, onSaved }: { incident: Incident; monitors: Monitor[]; onClose: () => void; onSaved: () => void }) {
  const initialMonitors = incident.monitorIds ?? []
  const [title, setTitle] = useState(incident.title)
  const [impact, setImpact] = useState(incident.impact)
  const [selectedMonitors, setSelectedMonitors] = useState<number[]>(initialMonitors)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      // Links first, so the change the status page receives from the patch already carries them.
      const linksChanged = selectedMonitors.length !== initialMonitors.length || selectedMonitors.some((id) => !initialMonitors.includes(id))
      if (linksChanged) await api.post(`/admin/incidents/${incident.id}/monitors`, { monitorIds: selectedMonitors })
      if (title !== incident.title || impact !== incident.impact) await api.patch(`/admin/incidents/${incident.id}`, { title, impact })
      onSaved()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Failed to save the incident. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal title="Edit Incident" icon="edit" onClose={onClose} flush>
      <form onSubmit={handleSubmit}>
        <div className="p-6 space-y-4">
          <Field label="Title" required>
            <input value={title} onChange={(e) => setTitle(e.target.value)} required className="input-sig" />
          </Field>
          <Field label="Impact">
            <select value={impact} onChange={(e) => setImpact(e.target.value as Incident['impact'])} className="input-sig">
              <option value="minor">Minor</option>
              <option value="major">Major</option>
              <option value="critical">Critical</option>
            </select>
          </Field>
          <MonitorPicker monitors={monitors} selected={selectedMonitors} onChange={setSelectedMonitors} />
          {error && <Alert tone="error">{error}</Alert>}
        </div>
        <ModalFooter>
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" disabled={loading || !title.trim()} className="btn btn-primary">
            {loading ? 'Saving…' : 'Save'}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  )
}

function CreateIncidentModal({ monitors, onClose, onSaved }: { monitors: Monitor[]; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState('investigating')
  const [impact, setImpact] = useState('minor')
  const [selectedMonitors, setSelectedMonitors] = useState<number[]>([])
  const [notifySubscribers, setNotifySubscribers] = useState(true)
  const [draft, setDraft] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { data: templates = [] } = useQuery<IncidentTemplate[]>({
    queryKey: TEMPLATES_KEY,
    queryFn: () => api.get('/admin/incident-templates'),
  })

  // Only the title and impact are taken over; the other placeholders need an outage to fill them in.
  function applyTemplate(id: string) {
    const template = templates.find((t) => String(t.id) === id)
    if (!template) return
    const names = monitors.filter((m) => selectedMonitors.includes(m.id)).map((m) => m.name).join(', ')
    setTitle(template.title.replace(/{{s*monitors*}}/g, names || 'service'))
    setImpact(template.impact)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      // Monitors go in the same request so component-scoped subscribers are matched.
      await api.post<Incident>('/admin/incidents', { title, status, impact, monitorIds: selectedMonitors, notifySubscribers, draft })
      onSaved()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Failed to create the incident. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal title="New Incident" icon="warning" onClose={onClose} flush>
      <form onSubmit={handleSubmit}>
        <div className="p-6 space-y-4">
        {templates.length > 0 && (
          <Field label="Start from template">
            <select defaultValue="" onChange={(e) => applyTemplate(e.target.value)} className="input-sig">
              <option value="">None</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        )}
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
              <option value="minor">Minor</option>
              <option value="major">Major</option>
              <option value="critical">Critical</option>
            </select>
          </Field>
        </div>

        <MonitorPicker monitors={monitors} selected={selectedMonitors} onChange={setSelectedMonitors} />

        <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--m3-on-surface)' }}>
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
          Save as draft (visible only here until published)
        </label>
        {!draft && <NotifySubscribersCheckbox checked={notifySubscribers} onChange={setNotifySubscribers} />}

        {error && <Alert tone="error">{error}</Alert>}
        </div>

        <ModalFooter>
          <button type="button" onClick={onClose} className="btn btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={loading} className="btn btn-primary">
            {loading ? 'Creating…' : 'Create Incident'}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  )
}
