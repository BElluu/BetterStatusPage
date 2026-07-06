import { useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { MaintenanceWindow, Monitor } from '@bsp/shared'
import { ConfirmModal } from '../components/ConfirmModal'

type Tab = 'active' | 'upcoming' | 'past'

function formatDateTime(ms: number) {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function formatDuration(startMs: number, endMs: number) {
  const diffMs = endMs - startMs
  const totalMins = Math.round(diffMs / 60000)
  if (totalMins < 60) return `${totalMins}m`
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

function countdown(endsAt: number) {
  const remaining = endsAt - Date.now()
  if (remaining <= 0) return 'Ended'
  const totalMins = Math.ceil(remaining / 60000)
  if (totalMins < 60) return `${totalMins}m remaining`
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  return mins > 0 ? `${hours}h ${mins}m remaining` : `${hours}h remaining`
}

export default function MaintenancePage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('active')
  const [showCreate, setShowCreate] = useState(false)
  const [editing, setEditing] = useState<MaintenanceWindow | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<MaintenanceWindow | null>(null)
  const [confirmEndEarly, setConfirmEndEarly] = useState<MaintenanceWindow | null>(null)

  const { data: windows = [] } = useQuery<MaintenanceWindow[]>({
    queryKey: ['maintenance'],
    queryFn: () => api.get('/admin/maintenance'),
    refetchInterval: 30_000,
  })

  const { data: monitors = [] } = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/maintenance/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['maintenance'] }),
  })

  const endEarlyMutation = useMutation({
    mutationFn: (id: number) => api.patch(`/admin/maintenance/${id}`, { endsAt: Date.now() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['maintenance'] }),
  })

  const now = Date.now()
  const { active, upcoming, past } = useMemo(() => {
    const active: MaintenanceWindow[] = []
    const upcoming: MaintenanceWindow[] = []
    const past: MaintenanceWindow[] = []
    for (const w of windows) {
      if (w.endsAt < now) past.push(w)
      else if (w.startsAt > now) upcoming.push(w)
      else active.push(w)
    }
    return { active, upcoming, past }
  }, [windows, now])

  const displayed = tab === 'active' ? active : tab === 'upcoming' ? upcoming : past

  const tabCounts = { active: active.length, upcoming: upcoming.length, past: past.length }

  function monitorName(id: number) {
    return monitors.find((m) => m.id === id)?.name ?? `#${id}`
  }

  return (
    <div className="p-8 space-y-6 fade-up">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-headline font-bold text-2xl" style={{ color: 'var(--m3-on-surface)' }}>Maintenance Windows</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>
            {active.length} active · {upcoming.length} upcoming · {past.length} past
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="btn-primary flex items-center gap-2 py-3 px-4 rounded-xl font-headline font-bold text-sm transition-all active:scale-[0.98]"
          style={{ background: 'var(--m3-on-surface)', color: 'var(--m3-surface)' }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>add_circle</span>
          Schedule Maintenance
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl w-fit" style={{ background: 'var(--m3-surface-container)' }}>
        {(['active', 'upcoming', 'past'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="px-5 py-2 rounded-lg text-sm font-bold transition-all capitalize"
            style={{
              background: tab === t ? 'var(--m3-surface-container-lowest)' : 'transparent',
              color: tab === t ? 'var(--m3-on-surface)' : 'var(--m3-secondary)',
              boxShadow: tab === t ? '0 1px 4px rgba(19,27,46,0.08)' : 'none',
            }}
          >
            {t}
            {tabCounts[t] > 0 && (
              <span
                className="ml-2 inline-flex items-center justify-center w-5 h-5 rounded-full text-xs"
                style={{
                  background: t === 'active' ? 'var(--m3-primary)' : 'var(--m3-surface-container-high)',
                  color: t === 'active' ? 'var(--m3-on-primary)' : 'var(--m3-secondary)',
                }}
              >
                {tabCounts[t]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="space-y-2">
        {displayed.map((win) => {
          const isActive = win.startsAt <= now && win.endsAt >= now
          const affectedNames = win.monitorIds.length === 0
            ? ['All monitors']
            : win.monitorIds.map(monitorName)

          return (
            <div
              key={win.id}
              className="rounded-2xl px-5 py-4 flex items-start gap-4"
              style={{
                background: 'var(--m3-surface-container-low)',
                border: `1px solid ${isActive ? 'var(--m3-primary)' : 'var(--m3-outline-variant)'}`,
              }}
            >
              <span
                className="material-symbols-outlined flex-shrink-0 mt-0.5"
                style={{
                  fontSize: '22px',
                  color: isActive ? 'var(--m3-primary)' : 'var(--m3-secondary)',
                  fontVariationSettings: isActive ? "'FILL' 1" : "'FILL' 0",
                }}
              >
                construction
              </span>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-medium text-sm" style={{ color: 'var(--m3-on-surface)' }}>
                    {win.name}
                  </span>
                  {isActive && (
                    <span
                      className="text-xs px-2 py-0.5 rounded-full font-bold animate-pulse"
                      style={{ background: 'var(--m3-primary-fixed)', color: 'var(--m3-primary)' }}
                    >
                      ACTIVE · {countdown(win.endsAt)}
                    </span>
                  )}
                </div>

                {win.description && (
                  <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>{win.description}</p>
                )}

                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs" style={{ color: 'var(--m3-secondary)' }}>
                  <span className="flex items-center gap-1">
                    <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>schedule</span>
                    {formatDateTime(win.startsAt)} → {formatDateTime(win.endsAt)}
                    <span className="ml-1 opacity-70">({formatDuration(win.startsAt, win.endsAt)})</span>
                  </span>
                </div>

                <div className="flex flex-wrap gap-1.5 mt-2">
                  {affectedNames.map((name) => (
                    <span
                      key={name}
                      className="text-xs px-2 py-0.5 rounded-full"
                      style={{
                        background: 'var(--m3-surface-container)',
                        color: 'var(--m3-secondary)',
                        border: '1px solid var(--m3-outline-variant)',
                      }}
                    >
                      {name}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex gap-2 flex-shrink-0">
                {isActive && (
                  <button
                    onClick={() => setConfirmEndEarly(win)}
                    className="text-xs px-3 py-1.5 rounded-lg font-semibold transition-colors"
                    style={{ color: 'var(--m3-primary)', background: 'var(--m3-primary-fixed)' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.8' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '1' }}
                  >
                    End now
                  </button>
                )}
                <button
                  onClick={() => setEditing(win)}
                  className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                  style={{ color: 'var(--m3-secondary)' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--m3-surface-container-high)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-on-surface)' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = ''; (e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-secondary)' }}
                >
                  Edit
                </button>
                <button
                  onClick={() => setConfirmDelete(win)}
                  className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                  style={{ color: 'var(--m3-down)' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--m3-down-bg)' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '' }}
                >
                  Delete
                </button>
              </div>
            </div>
          )
        })}

        {displayed.length === 0 && (
          <div className="text-center py-14 text-sm" style={{ color: 'var(--m3-secondary)' }}>
            {tab === 'active' && 'No active maintenance windows. All systems running normally.'}
            {tab === 'upcoming' && 'No upcoming maintenance scheduled.'}
            {tab === 'past' && 'No past maintenance windows.'}
          </div>
        )}
      </div>

      {showCreate && (
        <MaintenanceModal
          monitors={monitors}
          onClose={() => setShowCreate(false)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ['maintenance'] }); setShowCreate(false) }}
        />
      )}
      {editing && (
        <MaintenanceModal
          monitors={monitors}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ['maintenance'] }); setEditing(null) }}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete maintenance window"
          message={`Delete "${confirmDelete.name}"? This cannot be undone.`}
          onConfirm={() => { deleteMutation.mutate(confirmDelete.id); setConfirmDelete(null) }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {confirmEndEarly && (
        <ConfirmModal
          title="End maintenance early"
          message={`End "${confirmEndEarly.name}" now? The end time will be set to the current time.`}
          confirmLabel="End now"
          danger={false}
          onConfirm={() => { endEarlyMutation.mutate(confirmEndEarly.id); setConfirmEndEarly(null) }}
          onCancel={() => setConfirmEndEarly(null)}
        />
      )}
    </div>
  )
}

function toLocalDatetimeValue(ms: number) {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromLocalDatetimeValue(val: string): number {
  return new Date(val).getTime()
}

function MaintenanceModal({
  monitors,
  initial,
  onClose,
  onSaved,
}: {
  monitors: Monitor[]
  initial?: MaintenanceWindow
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!initial

  // Default: starts in 1h, ends in 3h
  const defaultStart = toLocalDatetimeValue(Date.now() + 60 * 60 * 1000)
  const defaultEnd = toLocalDatetimeValue(Date.now() + 3 * 60 * 60 * 1000)

  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [startsAt, setStartsAt] = useState(initial ? toLocalDatetimeValue(initial.startsAt) : defaultStart)
  const [endsAt, setEndsAt] = useState(initial ? toLocalDatetimeValue(initial.endsAt) : defaultEnd)
  const [selectedMonitors, setSelectedMonitors] = useState<number[]>(initial?.monitorIds ?? [])
  const [allMonitors, setAllMonitors] = useState(initial ? initial.monitorIds.length === 0 : false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const startMs = fromLocalDatetimeValue(startsAt)
    const endMs = fromLocalDatetimeValue(endsAt)
    if (endMs <= startMs) {
      setError('End time must be after start time.')
      return
    }
    setLoading(true)
    try {
      const payload = {
        name,
        description: description.trim() || null,
        startsAt: startMs,
        endsAt: endMs,
        monitorIds: allMonitors ? [] : selectedMonitors,
      }
      if (isEdit) {
        await api.patch(`/admin/maintenance/${initial!.id}`, payload)
      } else {
        await api.post('/admin/maintenance', payload)
      }
      onSaved()
    } catch {
      setError('Failed to save. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  function toggleMonitor(id: number) {
    setSelectedMonitors((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.55)', overflowY: 'auto' }}>
      <div style={{ display: 'flex', minHeight: '100%', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
        <div className="rounded-2xl w-full max-w-lg" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-5" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined" style={{ fontSize: '22px', color: 'var(--m3-primary)' }}>construction</span>
              <h3 className="font-headline font-bold text-lg" style={{ color: 'var(--m3-on-surface)' }}>
                {isEdit ? 'Edit Maintenance Window' : 'Schedule Maintenance'}
              </h3>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-xl leading-none"
              style={{ color: 'var(--m3-secondary)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--m3-surface-container-high)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-on-surface)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = ''; (e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-secondary)' }}
            >
              ×
            </button>
          </div>

          <form onSubmit={handleSubmit} className="p-6 space-y-5">
            {/* Name */}
            <div>
              <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>
                Name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="input-sig"
                placeholder="Scheduled database maintenance"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>
                Description <span style={{ color: 'var(--m3-outline)' }}>(optional)</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className="input-sig resize-none"
                placeholder="Brief description visible on the status page…"
              />
            </div>

            {/* Time range */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>
                  Starts At
                </label>
                <input
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                  required
                  className="input-sig"
                />
              </div>
              <div>
                <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>
                  Ends At
                </label>
                <input
                  type="datetime-local"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                  required
                  className="input-sig"
                />
              </div>
            </div>

            {/* Affected monitors */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>
                  Affected Monitors
                </label>
                <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--m3-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={allMonitors}
                    onChange={(e) => setAllMonitors(e.target.checked)}
                    style={{ accentColor: 'var(--admin-control-accent)' }}
                  />
                  All monitors
                </label>
              </div>
              {!allMonitors && (
                <div
                  className="space-y-1 max-h-40 overflow-y-auto rounded-lg p-2"
                  style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}
                >
                  {monitors.map((m) => (
                    <label key={m.id} className="flex items-center gap-2.5 text-sm cursor-pointer px-2 py-1.5 rounded-md"
                      onMouseEnter={(e) => ((e.currentTarget as HTMLLabelElement).style.background = 'var(--m3-surface-container-high)')}
                      onMouseLeave={(e) => ((e.currentTarget as HTMLLabelElement).style.background = '')}
                    >
                      <input
                        type="checkbox"
                        checked={selectedMonitors.includes(m.id)}
                        onChange={() => toggleMonitor(m.id)}
                        style={{ accentColor: 'var(--admin-control-accent)' }}
                      />
                      <span style={{ color: 'var(--m3-on-surface)' }}>{m.name}</span>
                      <span className="ml-auto font-mono text-xs" style={{ color: 'var(--m3-outline)' }}>{m.type}</span>
                    </label>
                  ))}
                  {monitors.length === 0 && (
                    <p className="text-xs px-2 py-2" style={{ color: 'var(--m3-secondary)' }}>No monitors available</p>
                  )}
                </div>
              )}
              {!allMonitors && selectedMonitors.length === 0 && (
                <p className="text-xs mt-1.5" style={{ color: 'var(--m3-outline)' }}>
                  No monitors selected — notifications will not be suppressed.
                </p>
              )}
            </div>

            {error && (
              <p className="text-sm" style={{ color: 'var(--m3-down)' }}>{error}</p>
            )}

            <div className="flex justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="text-sm px-4 py-2 rounded-lg"
                style={{ color: 'var(--m3-secondary)' }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-on-surface)')}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-secondary)')}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="btn-primary text-sm font-semibold px-4 py-2 rounded-lg transition-all"
                style={{
                  background: loading ? 'var(--m3-surface-container-high)' : 'var(--m3-primary)',
                  color: loading ? 'var(--m3-secondary)' : 'var(--m3-on-primary)',
                  opacity: loading ? 0.7 : 1,
                }}
              >
                {loading ? 'Saving…' : isEdit ? 'Save Changes' : 'Schedule'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>,
    document.body,
  )
}
