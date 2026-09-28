import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { ConfirmModal } from '../components/ConfirmModal'
import { Alert, EmptyState, ErrorState, LoadingState, PageContainer, PageHeader, Switch } from '../components/ui'

interface BackupInfo { filename: string; size: number; createdAt: number }
interface BackupConfig { enabled: boolean; frequency: 'daily' | 'weekly'; hour: number; minute: number; weekday: number; retention: number }
interface BackupStatus { state: string; lastCompletedAt: number | null; lastFilename: string | null; lastError: string | null }
interface State { backups: BackupInfo[]; config: BackupConfig; status: BackupStatus }
type BusyAction = 'create' | 'validate' | 'save' | 'delete'
interface Message { tone: 'success' | 'error' | 'warning'; text: string }
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)

export default function BackupsPage() {
  const [state, setState] = useState<State | null>(null)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState<BusyAction | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [savedConfig, setSavedConfig] = useState<BackupConfig | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const load = useCallback(() => api.get<State>('/admin/backups')
    .then((data) => { setState(data); setSavedConfig(data.config); setLoadError('') })
    .catch((e: unknown) => setLoadError(errorText(e))), [])
  useEffect(() => { void load() }, [load])

  async function create() {
    setBusy('create'); setMessage(null)
    try { await api.post('/admin/backups', {}); await load(); setMessage({ tone: 'success', text: 'Backup created successfully.' }) }
    catch (e) { setMessage({ tone: 'error', text: errorText(e) }) } finally { setBusy(null) }
  }
  async function saveConfig(config: BackupConfig) {
    setBusy('save'); setMessage(null)
    try { const saved = await api.put<BackupConfig>('/admin/backups/config', config); setState((s) => s && ({ ...s, config: saved })); setSavedConfig(saved); setMessage({ tone: 'success', text: 'Schedule saved.' }) }
    catch (e) { setMessage({ tone: 'error', text: errorText(e) }) } finally { setBusy(null) }
  }
  async function validate(selected: File) {
    setBusy('validate'); setMessage(null)
    const form = new FormData(); form.append('file', selected)
    try {
      const result = await api.upload<{ manifest: { createdAt: number }; vaultKeyMatches: boolean | null }>('/admin/backups/validate', form)
      const keyMismatch = result.vaultKeyMatches === false
      const key = keyMismatch ? ' Warning: VAULT_ENCRYPTION_KEY does not match.' : ''
      setMessage({ tone: keyMismatch ? 'warning' : 'success', text: `Backup is valid (${new Date(result.manifest.createdAt).toLocaleString()}).${key} Stop the app and run: npm run restore -- --input <file>` })
    } catch (e) { setMessage({ tone: 'error', text: errorText(e) }) } finally { setBusy(null); if (file.current) file.current.value = '' }
  }
  async function removeBackup(filename: string) {
    setBusy('delete'); setMessage(null)
    try {
      await api.delete(`/admin/backups/${encodeURIComponent(filename)}?confirm=${encodeURIComponent(filename)}`)
      setDeleteTarget(null)
      await load()
      setMessage({ tone: 'success', text: 'Backup deleted.' })
    } catch (e) { setDeleteTarget(null); setMessage({ tone: 'error', text: errorText(e) }) } finally { setBusy(null) }
  }

  const header = <PageHeader title="Backups" subtitle="Create, download, validate and schedule complete application backups." />
  if (!state && loadError) return <PageContainer>{header}<ErrorState message={loadError} onRetry={() => void load()} /></PageContainer>
  if (!state) return <PageContainer>{header}<LoadingState label="Loading backups…" /></PageContainer>
  const config = state.config
  const scheduleChanged = JSON.stringify(config) !== JSON.stringify(savedConfig)
  const scheduleSummary = config.enabled
    ? `${config.frequency === 'daily' ? 'Every day' : `Every ${WEEKDAYS[config.weekday]}`} at ${String(config.hour).padStart(2, '0')}:${String(config.minute).padStart(2, '0')} · keep ${config.retention} ${config.retention === 1 ? 'backup' : 'backups'}`
    : 'Automatic backups are disabled'
  const updateConfig = (updates: Partial<BackupConfig>) => setState({ ...state, config: { ...config, ...updates } })
  return <PageContainer>
    {header}
    {message && <Alert tone={message.tone} onDismiss={() => setMessage(null)}>{message.text}</Alert>}
    {state.status.lastCompletedAt && <div className="text-sm" style={{ color: state.status.state === 'error' ? 'var(--m3-down)' : 'var(--m3-secondary)' }}>Last run: {new Date(state.status.lastCompletedAt).toLocaleString()} · {state.status.state}{state.status.lastError ? ` · ${state.status.lastError}` : ''}</div>}
    <section className="rounded-2xl p-6 space-y-4" style={{ background: 'var(--m3-surface-container-lowest)', color: 'var(--m3-on-surface)' }}>
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={busy !== null} onClick={create} className="btn btn-primary">{busy === 'create' ? 'Creating backup…' : 'Create backup'}</button>
        <button type="button" disabled={busy !== null} onClick={() => file.current?.click()} className="btn btn-secondary">{busy === 'validate' ? 'Validating…' : 'Validate restore file'}</button>
        <input ref={file} className="hidden" type="file" accept=".backup" aria-label="Restore file" onChange={(e) => { const selected = e.target.files?.[0]; if (selected) void validate(selected) }} />
      </div>
      <p className="text-sm" style={{ color: 'var(--m3-secondary)' }}>Restore is intentionally offline. The encryption key is never included; keep VAULT_ENCRYPTION_KEY separately.</p>
    </section>
    <section className="rounded-2xl overflow-hidden" style={{ background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)', color: 'var(--m3-on-surface)' }}>
      <div className="p-5 md:p-6 flex items-start justify-between gap-5">
        <div className="flex gap-4 min-w-0">
          <span className="material-symbols-outlined rounded-xl p-2.5 h-fit" aria-hidden="true" style={{ background: 'var(--admin-icon-container)', color: 'var(--admin-icon-color)' }}>schedule</span>
          <div>
            <h2 className="font-headline text-xl font-semibold">Automatic backups</h2>
            <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>Create backups on a recurring schedule using the server&apos;s local time.</p>
          </div>
        </div>
        <Switch checked={config.enabled} onChange={(enabled) => updateConfig({ enabled })} aria-label="Automatic backups" />
      </div>

      <div className="px-5 pb-5 md:px-6 md:pb-6">
        {config.enabled ? (
          <div className="rounded-2xl p-4 md:p-5 grid gap-5 md:grid-cols-3" style={{ background: 'var(--m3-surface-container-low)' }}>
            <fieldset>
              <legend className="font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Frequency</legend>
              <div className="grid grid-cols-2 rounded-xl overflow-hidden" style={{ border: '1px solid var(--m3-outline-variant)' }}>
                {(['daily', 'weekly'] as const).map((frequency) => {
                  const active = config.frequency === frequency
                  return (
                    <button
                      key={frequency}
                      type="button"
                      aria-pressed={active}
                      onClick={() => updateConfig({ frequency })}
                      className={`px-3 py-2 text-sm font-semibold transition-colors focus-ring ${active ? 'selection-active' : ''}`}
                      style={{ background: 'transparent', color: 'var(--m3-secondary)' }}
                    >
                      {frequency === 'daily' ? 'Daily' : 'Weekly'}
                    </button>
                  )
                })}
              </div>
            </fieldset>

            {config.frequency === 'weekly' && <label>
              <span className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Day of week</span>
              <select className="input-sig w-full" value={config.weekday} onChange={(e) => updateConfig({ weekday: Number(e.target.value) })}>{WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select>
            </label>}

            <label>
              <span className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Start time</span>
              <input className="input-sig w-full" type="time" step="60" value={`${String(config.hour).padStart(2, '0')}:${String(config.minute).padStart(2, '0')}`} onChange={(e) => { const parts = e.target.value.split(':'); const hour = Number(parts[0]); const minute = Number(parts[1]); if (parts.length === 2 && Number.isInteger(hour) && Number.isInteger(minute)) updateConfig({ hour, minute }) }} />
              <span className="block text-xs mt-1.5" style={{ color: 'var(--m3-secondary)' }}>Server local time</span>
            </label>

            <label>
              <span className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Retention</span>
              <div className="relative"><input className="input-sig w-full pr-24" type="number" min="1" max="365" value={config.retention} onChange={(e) => updateConfig({ retention: Number(e.target.value) })} /><span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm" aria-hidden="true" style={{ color: 'var(--m3-secondary)' }}>backups</span></div>
              <span className="block text-xs mt-1.5" style={{ color: 'var(--m3-secondary)' }}>Older automatic backups are removed after a successful run.</span>
            </label>
          </div>
        ) : <div className="rounded-xl px-4 py-3 text-sm flex items-center gap-3" style={{ background: 'var(--m3-surface-container-low)', color: 'var(--m3-secondary)' }}><span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '20px' }}>info</span>Enable scheduling to configure recurring backups.</div>}

        <div className="mt-5 pt-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
          <div><p className="text-xs font-mono uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Current schedule</p><p className="text-sm font-medium mt-1">{scheduleSummary}</p></div>
          <button type="button" disabled={busy !== null || !scheduleChanged} onClick={() => saveConfig(config)} className="btn btn-primary">{busy === 'save' ? 'Saving…' : scheduleChanged ? 'Save schedule' : 'Saved'}</button>
        </div>
      </div>
    </section>
    <section className="rounded-2xl overflow-hidden" style={{ background: 'var(--m3-surface-container-lowest)', color: 'var(--m3-on-surface)' }}>
      <h2 className="font-headline text-xl font-semibold p-6 pb-3">Available backups</h2>
      {state.backups.length === 0
        ? <div className="p-6 pt-0"><EmptyState icon="backup" title="No backups yet." description="Create a backup now or enable automatic backups." /></div>
        : state.backups.map((item) => <div key={item.filename} className="p-4 px-6 flex flex-wrap items-center justify-between gap-3" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
          <div className="min-w-0"><div className="font-mono text-sm break-all">{item.filename}</div><div className="text-xs" style={{ color: 'var(--m3-secondary)' }}>{new Date(item.createdAt).toLocaleString()} · {(item.size / 1024 / 1024).toFixed(2)} MB</div></div>
          <div className="flex gap-2">
            <button type="button" onClick={() => api.download(`/admin/backups/${encodeURIComponent(item.filename)}/download`, item.filename)} aria-label={`Download ${item.filename}`} className="btn btn-secondary btn-sm">Download</button>
            <button type="button" onClick={() => setDeleteTarget(item.filename)} aria-label={`Delete ${item.filename}`} className="btn btn-danger-outline btn-sm">Delete</button>
          </div>
        </div>)}
    </section>
    {deleteTarget && <ConfirmModal title="Delete backup" message="This permanently deletes the backup archive. This action cannot be undone." confirmLabel="Delete backup" confirmationText={deleteTarget} pending={busy === 'delete'} pendingLabel="Deleting…" onConfirm={() => { if (!busy) void removeBackup(deleteTarget) }} onCancel={() => setDeleteTarget(null)} />}
  </PageContainer>
}
