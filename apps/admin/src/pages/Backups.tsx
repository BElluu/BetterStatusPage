import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { ConfirmModal } from '../components/ConfirmModal'

interface BackupInfo { filename: string; size: number; createdAt: number }
interface BackupConfig { enabled: boolean; frequency: 'daily' | 'weekly'; hour: number; minute: number; weekday: number; retention: number }
interface BackupStatus { state: string; lastCompletedAt: number | null; lastFilename: string | null; lastError: string | null }
interface State { backups: BackupInfo[]; config: BackupConfig; status: BackupStatus }
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export default function BackupsPage() {
  const [state, setState] = useState<State | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [savedConfig, setSavedConfig] = useState<BackupConfig | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const load = () => api.get<State>('/admin/backups').then((data) => { setState(data); setSavedConfig(data.config) }).catch((e: Error) => setMessage(e.message))
  useEffect(() => { void load() }, [])

  async function create() {
    setBusy(true); setMessage('')
    try { await api.post('/admin/backups', {}); await load(); setMessage('Backup created successfully.') }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  async function saveConfig(config: BackupConfig) {
    setBusy(true)
    try { const saved = await api.put<BackupConfig>('/admin/backups/config', config); setState((s) => s && ({ ...s, config: saved })); setSavedConfig(saved); setMessage('Schedule saved.') }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  async function validate(selected: File) {
    setBusy(true); setMessage('')
    const form = new FormData(); form.append('file', selected)
    try {
      const result = await api.upload<{ manifest: { createdAt: number }; vaultKeyMatches: boolean | null }>('/admin/backups/validate', form)
      const key = result.vaultKeyMatches === false ? ' Warning: VAULT_ENCRYPTION_KEY does not match.' : ''
      setMessage(`Backup is valid (${new Date(result.manifest.createdAt).toLocaleString()}).${key} Stop the app and run: npm run restore -- --input <file>`)
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)) } finally { setBusy(false); if (file.current) file.current.value = '' }
  }
  async function removeBackup(filename: string) {
    setBusy(true)
    try {
      await api.delete(`/admin/backups/${encodeURIComponent(filename)}?confirm=${encodeURIComponent(filename)}`)
      setDeleteTarget(null)
      await load()
      setMessage('Backup deleted.')
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  if (!state) return <div className="p-8" style={{ color: 'var(--m3-on-surface)' }}>Loading backups…</div>
  const config = state.config
  const scheduleChanged = JSON.stringify(config) !== JSON.stringify(savedConfig)
  const scheduleSummary = config.enabled
    ? `${config.frequency === 'daily' ? 'Every day' : `Every ${WEEKDAYS[config.weekday]}`} at ${String(config.hour).padStart(2, '0')}:${String(config.minute).padStart(2, '0')} · keep ${config.retention} ${config.retention === 1 ? 'backup' : 'backups'}`
    : 'Automatic backups are disabled'
  const updateConfig = (updates: Partial<BackupConfig>) => setState({ ...state, config: { ...config, ...updates } })
  return <div className="p-6 md:p-10 max-w-6xl mx-auto space-y-6" style={{ color: 'var(--m3-on-surface)' }}>
    <div><h1 className="text-3xl font-bold">Backups</h1><p style={{ color: 'var(--m3-secondary)' }}>Create, download, validate and schedule complete application backups.</p></div>
    {message && <div className="rounded-xl p-4" style={{ background: 'var(--m3-surface-container-high)' }}>{message}</div>}
    {state.status.lastCompletedAt && <div className="text-sm" style={{ color: state.status.state === 'error' ? 'var(--m3-error)' : 'var(--m3-secondary)' }}>Last run: {new Date(state.status.lastCompletedAt).toLocaleString()} · {state.status.state}{state.status.lastError ? ` · ${state.status.lastError}` : ''}</div>}
    <section className="rounded-2xl p-6 space-y-4" style={{ background: 'var(--m3-surface-container-lowest)' }}>
      <div className="flex flex-wrap gap-3">
        <button disabled={busy} onClick={create} className="btn-primary px-5 py-2.5 rounded-xl">Create backup</button>
        <button disabled={busy} onClick={() => file.current?.click()} className="px-5 py-2.5 rounded-xl" style={{ background: 'var(--m3-surface-container-high)' }}>Validate restore file</button>
        <input ref={file} className="hidden" type="file" accept=".backup" onChange={(e) => { const selected = e.target.files?.[0]; if (selected) void validate(selected) }} />
      </div>
      <p className="text-sm" style={{ color: 'var(--m3-secondary)' }}>Restore is intentionally offline. The encryption key is never included; keep VAULT_ENCRYPTION_KEY separately.</p>
    </section>
    <section className="rounded-2xl overflow-hidden" style={{ background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)' }}>
      <div className="p-5 md:p-6 flex items-start justify-between gap-5">
        <div className="flex gap-4 min-w-0">
          <span className="material-symbols-outlined rounded-xl p-2.5 h-fit" style={{ background: 'var(--admin-icon-container)', color: 'var(--admin-icon-color)' }}>schedule</span>
          <div>
            <h2 className="font-headline text-xl font-semibold">Automatic backups</h2>
            <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>Create backups on a recurring schedule using the server's local time.</p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={config.enabled}
          aria-label="Automatic backups"
          onClick={() => updateConfig({ enabled: !config.enabled })}
          className="relative flex-shrink-0 w-12 h-7 rounded-full transition-colors"
          style={{ background: config.enabled ? 'var(--m3-primary)' : 'var(--m3-outline-variant)' }}
        >
          <span className="absolute top-1 w-5 h-5 rounded-full transition-all" style={{ left: config.enabled ? '24px' : '4px', background: config.enabled ? 'var(--m3-on-primary)' : 'var(--m3-outline)' }} />
        </button>
      </div>

      <div className="px-5 pb-5 md:px-6 md:pb-6">
        {config.enabled ? (
          <div className="rounded-2xl p-4 md:p-5 grid gap-5 md:grid-cols-3" style={{ background: 'var(--m3-surface-container-low)' }}>
            <fieldset>
              <legend className="font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Frequency</legend>
              <div className="grid grid-cols-2 rounded-xl p-1" style={{ background: 'var(--m3-surface-container-high)' }}>
                {(['daily', 'weekly'] as const).map((frequency) => <button key={frequency} type="button" onClick={() => updateConfig({ frequency })} className="rounded-lg px-3 py-2 text-sm font-semibold transition-colors" style={{ background: config.frequency === frequency ? 'var(--m3-surface-container-lowest)' : 'transparent', color: config.frequency === frequency ? 'var(--m3-on-surface)' : 'var(--m3-secondary)', boxShadow: config.frequency === frequency ? '0 1px 3px rgba(0,0,0,0.08)' : 'none' }}>{frequency === 'daily' ? 'Daily' : 'Weekly'}</button>)}
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
              <div className="relative"><input className="input-sig w-full pr-24" type="number" min="1" max="365" value={config.retention} onChange={(e) => updateConfig({ retention: Number(e.target.value) })} /><span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm" style={{ color: 'var(--m3-secondary)' }}>backups</span></div>
              <span className="block text-xs mt-1.5" style={{ color: 'var(--m3-secondary)' }}>Older automatic backups are removed after a successful run.</span>
            </label>
          </div>
        ) : <div className="rounded-xl px-4 py-3 text-sm flex items-center gap-3" style={{ background: 'var(--m3-surface-container-low)', color: 'var(--m3-secondary)' }}><span className="material-symbols-outlined" style={{ fontSize: '20px' }}>info</span>Enable scheduling to configure recurring backups.</div>}

        <div className="mt-5 pt-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
          <div><p className="text-xs font-mono uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Current schedule</p><p className="text-sm font-medium mt-1">{scheduleSummary}</p></div>
          <button disabled={busy || !scheduleChanged} onClick={() => saveConfig(config)} className="btn-primary px-5 py-2.5 rounded-xl font-semibold text-sm transition-all">{busy ? 'Saving…' : scheduleChanged ? 'Save schedule' : 'Saved'}</button>
        </div>
      </div>
    </section>
    <section className="rounded-2xl overflow-hidden" style={{ background: 'var(--m3-surface-container-lowest)' }}>
      <h2 className="text-xl font-semibold p-6 pb-3">Available backups</h2>
      {state.backups.length === 0 ? <p className="p-6 pt-0" style={{ color: 'var(--m3-secondary)' }}>No backups yet.</p> : state.backups.map((item) => <div key={item.filename} className="p-4 px-6 flex flex-wrap items-center justify-between gap-3" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
        <div><div className="font-mono text-sm">{item.filename}</div><div className="text-xs" style={{ color: 'var(--m3-secondary)' }}>{new Date(item.createdAt).toLocaleString()} · {(item.size / 1024 / 1024).toFixed(2)} MB</div></div>
        <div className="flex gap-2"><button onClick={() => api.download(`/admin/backups/${encodeURIComponent(item.filename)}/download`, item.filename)} className="px-3 py-2 rounded-lg">Download</button><button onClick={() => setDeleteTarget(item.filename)} className="px-3 py-2 rounded-lg" style={{ color: 'var(--m3-error)' }}>Delete</button></div>
      </div>)}
    </section>
    {deleteTarget && <ConfirmModal title="Delete backup" message="This permanently deletes the backup archive. This action cannot be undone." confirmLabel="Delete backup" confirmationText={deleteTarget} onConfirm={() => { if (!busy) void removeBackup(deleteTarget) }} onCancel={() => setDeleteTarget(null)} />}
  </div>
}
