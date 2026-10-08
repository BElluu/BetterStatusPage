import { useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { MaintenanceWindow, Monitor } from '@bsp/shared'
import { ConfirmModal } from '../components/ConfirmModal'
import { NotifySubscribersCheckbox } from '../components/subscribers/NotifySubscribersCheckbox'
import { ModalHeader, ModalShell } from '../components/ModalShell'
import { Alert, EmptyState, ErrorState, Field, LoadingState, PageContainer, PageHeader, useToast } from '../components/ui'

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

function countdown(endsAt: number, now: number) {
  const remaining = endsAt - now
  if (remaining <= 0) return 'Ended'
  const totalMins = Math.ceil(remaining / 60000)
  if (totalMins < 60) return `${totalMins}m remaining`
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  return mins > 0 ? `${hours}h ${mins}m remaining` : `${hours}h remaining`
}

/** Current time, re-read every 30 seconds so windows move between tabs and countdowns stay fresh. */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

export default function MaintenancePage() {
  const qc = useQueryClient()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('active')
  const [showCreate, setShowCreate] = useState(false)
  const [editing, setEditing] = useState<MaintenanceWindow | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<MaintenanceWindow | null>(null)
  const [confirmEndEarly, setConfirmEndEarly] = useState<MaintenanceWindow | null>(null)

  const { data: windows = [], isPending, isError, refetch } = useQuery<MaintenanceWindow[]>({
    queryKey: ['maintenance'],
    queryFn: () => api.get('/admin/maintenance'),
    refetchInterval: 30_000,
  })

  const { data: monitors = [] } = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
  })

  const deleteMutation = useMutation({
    mutationFn: (win: MaintenanceWindow) => api.delete(`/admin/maintenance/${win.id}`),
    onSuccess: (_data, win) => {
      qc.invalidateQueries({ queryKey: ['maintenance'] })
      setConfirmDelete(null)
      toast.success(`Deleted "${win.name}"`)
    },
    onError: (err) => toast.error(`Couldn't delete maintenance window: ${(err as Error).message}`),
  })

  const endEarlyMutation = useMutation({
    mutationFn: (win: MaintenanceWindow) => api.patch(`/admin/maintenance/${win.id}`, { endsAt: Date.now() }),
    onSuccess: (_data, win) => {
      qc.invalidateQueries({ queryKey: ['maintenance'] })
      setConfirmEndEarly(null)
      toast.success(`Ended "${win.name}"`)
    },
    onError: (err) => toast.error(`Couldn't end maintenance: ${(err as Error).message}`),
  })

  const now = useNow()
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
    <PageContainer>
      <PageHeader
        title="Maintenance Windows"
        subtitle={isPending || isError ? undefined : `${active.length} active · ${upcoming.length} upcoming · ${past.length} past`}
        actions={
          <button type="button" onClick={() => setShowCreate(true)} className="btn btn-primary">
            <span className="material-symbols-outlined" aria-hidden="true">add_circle</span>
            Schedule Maintenance
          </button>
        }
      />

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl w-fit max-w-full overflow-x-auto" style={{ background: 'var(--m3-surface-container)' }}>
        {(['active', 'upcoming', 'past'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
            className="px-5 py-2 rounded-lg text-sm font-bold transition-all capitalize focus-ring"
            style={{
              background: tab === t ? 'var(--m3-surface-container-lowest)' : 'transparent',
              color: tab === t ? 'var(--m3-on-surface)' : 'var(--m3-secondary)',
              boxShadow: tab === t ? '0 1px 4px rgba(19,27,46,0.08)' : 'none',
            }}
          >
            {t}
            {tabCounts[t] > 0 && (
              <span
                className={`ml-2 inline-flex items-center justify-center w-5 h-5 rounded-full text-xs ${t === 'active' ? 'maintenance-active-count' : ''}`}
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
      {isPending ? (
        <LoadingState label="Loading maintenance windows…" />
      ) : isError ? (
        <ErrorState message="Couldn't load maintenance windows." onRetry={() => void refetch()} />
      ) : (
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
                      ACTIVE · {countdown(win.endsAt, now)}
                    </span>
                  )}
                </div>

                {win.description && (
                  <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>{win.description}</p>
                )}

                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs" style={{ color: 'var(--m3-secondary)' }}>
                  <span className="flex items-center gap-1">
                    <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '14px' }}>schedule</span>
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

              <div className="flex items-center gap-1 flex-shrink-0">
                {isActive && (
                  <button type="button" onClick={() => setConfirmEndEarly(win)} className="btn btn-primary btn-sm mr-1">
                    End now
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setEditing(win)}
                  title="Edit"
                  aria-label={`Edit ${win.name}`}
                  className="btn-icon"
                >
                  <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>edit</span>
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(win)}
                  title="Delete"
                  aria-label={`Delete ${win.name}`}
                  className="btn-icon hover:!bg-[var(--m3-down-bg)]"
                  style={{ color: 'var(--m3-down)' }}
                >
                  <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>delete</span>
                </button>
              </div>
            </div>
          )
        })}

        {displayed.length === 0 && (
          <EmptyState
            icon="construction"
            title={tab === 'active' ? 'No active maintenance windows' : tab === 'upcoming' ? 'No upcoming maintenance scheduled' : 'No past maintenance windows'}
          />
        )}
      </div>
      )}

      {showCreate && (
        <MaintenanceModal
          monitors={monitors}
          onClose={() => setShowCreate(false)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ['maintenance'] }); setShowCreate(false); toast.success('Maintenance scheduled') }}
        />
      )}
      {editing && (
        <MaintenanceModal
          monitors={monitors}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ['maintenance'] }); setEditing(null); toast.success('Maintenance window updated') }}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete maintenance window"
          message={`Delete "${confirmDelete.name}"? This cannot be undone.`}
          pending={deleteMutation.isPending}
          pendingLabel="Deleting…"
          onConfirm={() => deleteMutation.mutate(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {confirmEndEarly && (
        <ConfirmModal
          title="End maintenance early"
          message={`End "${confirmEndEarly.name}" now? The end time will be set to the current time.`}
          confirmLabel="End now"
          danger={false}
          pending={endEarlyMutation.isPending}
          pendingLabel="Ending…"
          onConfirm={() => endEarlyMutation.mutate(confirmEndEarly)}
          onCancel={() => setConfirmEndEarly(null)}
        />
      )}
    </PageContainer>
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

const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'))
const MINUTES = Array.from({ length: 60 }, (_, minute) => String(minute).padStart(2, '0'))

export function DateTimeInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  const [date = '', time = '00:00'] = value.split('T')
  const [hour = '00', minute = '00'] = time.split(':')

  function update(nextDate: string, nextHour: string, nextMinute: string) {
    onChange(nextDate ? `${nextDate}T${nextHour}:${nextMinute}` : '')
  }

  return (
    <div className="space-y-2">
      <input
        type="date"
        value={date}
        onChange={(event) => update(event.target.value, hour, minute)}
        required
        aria-label={`${label} — YYYY-MM-DD`}
        className="input-sig"
      />
      <div className="flex items-center gap-2">
        <select
          value={hour}
          onChange={(event) => update(date, event.target.value, minute)}
          aria-label={`${label} — HH`}
          className="input-sig"
        >
          {HOURS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <span aria-hidden="true" className="font-bold" style={{ color: 'var(--m3-secondary)' }}>:</span>
        <select
          value={minute}
          onChange={(event) => update(date, hour, event.target.value)}
          aria-label={`${label} — MM`}
          className="input-sig"
        >
          {MINUTES.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </div>
    </div>
  )
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
  const title = isEdit ? 'Edit Maintenance Window' : 'Schedule Maintenance'

  // Default: starts in 1h, ends in 3h
  const defaultStart = toLocalDatetimeValue(Date.now() + 60 * 60 * 1000)
  const defaultEnd = toLocalDatetimeValue(Date.now() + 3 * 60 * 60 * 1000)

  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [startsAt, setStartsAt] = useState(initial ? toLocalDatetimeValue(initial.startsAt) : defaultStart)
  const [endsAt, setEndsAt] = useState(initial ? toLocalDatetimeValue(initial.endsAt) : defaultEnd)
  const [selectedMonitors, setSelectedMonitors] = useState<number[]>(initial?.monitorIds ?? [])
  const [allMonitors, setAllMonitors] = useState(initial ? initial.monitorIds.length === 0 : false)
  const [notifySubscribers, setNotifySubscribers] = useState(true)
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
    if (!allMonitors && selectedMonitors.length === 0) {
      setError('Select at least one monitor or choose all monitors.')
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
        await api.post('/admin/maintenance', { ...payload, notifySubscribers })
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

  return (
    <ModalShell onClose={onClose} label={title}>
      <div className="rounded-2xl w-full max-w-lg" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
        {/* Header */}
        <ModalHeader icon="construction" title={title} onClose={onClose} />

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <Field label="Name" required>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="input-sig"
              placeholder="Scheduled database maintenance"
            />
          </Field>

          <Field label={<>Description <span style={{ color: 'var(--m3-outline)' }}>(optional)</span></>}>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="input-sig resize-none"
              placeholder="Brief description visible on the status page…"
            />
          </Field>

          {/* Time range */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <fieldset>
              <legend className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>
                Starts At
              </legend>
              <DateTimeInput
                label="Starts At"
                value={startsAt}
                onChange={setStartsAt}
              />
            </fieldset>
            <fieldset>
              <legend className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>
                Ends At
              </legend>
              <DateTimeInput
                label="Ends At"
                value={endsAt}
                onChange={setEndsAt}
              />
            </fieldset>
          </div>

          {/* Affected monitors */}
          <fieldset aria-labelledby="maintenance-affected-monitors">
            <div className="flex items-center justify-between mb-2">
              <span id="maintenance-affected-monitors" className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>
                Affected Monitors
              </span>
              <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--m3-secondary)' }}>
                <input
                  type="checkbox"
                  checked={allMonitors}
                  onChange={(e) => setAllMonitors(e.target.checked)}
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
                  <label key={m.id} className="flex items-center gap-2.5 text-sm cursor-pointer px-2 py-1.5 rounded-md hover:bg-surface-container-high">
                    <input
                      type="checkbox"
                      checked={selectedMonitors.includes(m.id)}
                      onChange={() => toggleMonitor(m.id)}
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
          </fieldset>

          {!isEdit && <NotifySubscribersCheckbox checked={notifySubscribers} onChange={setNotifySubscribers} />}

          {error && <Alert tone="error">{error}</Alert>}

          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={loading} className="btn btn-primary">
              {loading ? 'Saving…' : isEdit ? 'Save Changes' : 'Schedule'}
            </button>
          </div>
        </form>
      </div>
    </ModalShell>
  )
}
