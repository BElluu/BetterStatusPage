import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { NotificationChannel, SmtpSettings, VaultRef } from '@bsp/shared'
import ChannelFormModal from '../components/notifications/ChannelFormModal'
import { ConfirmModal } from '../components/ConfirmModal'

export default function NotificationsPage() {
  const qc = useQueryClient()
  const [editingChannel, setEditingChannel] = useState<NotificationChannel | null>(null)
  const [showCreate, setShowCreate]         = useState(false)
  const [confirmDelete, setConfirmDelete]   = useState<NotificationChannel | null>(null)
  const [showSmtp, setShowSmtp]             = useState(false)

  const { data: channels = [], isLoading } = useQuery<NotificationChannel[]>({
    queryKey: ['notification-channels'],
    queryFn: () => api.get('/admin/notifications/channels'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/notifications/channels/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-channels'] }),
  })

  function handleSaved() {
    qc.invalidateQueries({ queryKey: ['notification-channels'] })
    setEditingChannel(null)
    setShowCreate(false)
  }

  return (
    <div className="p-8 space-y-6 fade-up">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-headline font-bold text-2xl" style={{ color: 'var(--m3-on-surface)' }}>Notifications</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>
            Alert channels fired when a monitor changes status
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowSmtp(true)}
            className="text-sm font-semibold px-4 py-2.5 rounded-lg transition-all flex items-center gap-1.5"
            style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-on-surface)', border: '1px solid var(--m3-outline-variant)' }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>mail_settings</span>
            SMTP Settings
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="text-sm font-semibold px-4 py-2.5 rounded-lg transition-all"
            style={{ background: 'var(--m3-primary)', color: 'var(--m3-on-primary)' }}
          >
            + Add Channel
          </button>
        </div>
      </div>

      {/* Info banner */}
      <div
        className="flex items-start gap-3 rounded-xl px-4 py-3"
        style={{ background: 'rgba(57,128,244,0.08)', border: '1px solid rgba(57,128,244,0.20)' }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: '18px', color: '#3980f4', flexShrink: 0, marginTop: '1px' }}>info</span>
        <p className="text-sm" style={{ color: 'var(--m3-on-surface-variant)' }}>
          Create notification channels here, then assign them to individual monitors via the monitor's edit form.
          Use <code className="text-xs px-1 rounded" style={{ background: 'var(--m3-surface-container-high)', fontFamily: 'monospace' }}>{'{{monitor_name}}'}</code>,{' '}
          <code className="text-xs px-1 rounded" style={{ background: 'var(--m3-surface-container-high)', fontFamily: 'monospace' }}>{'{{status}}'}</code>,{' '}
          <code className="text-xs px-1 rounded" style={{ background: 'var(--m3-surface-container-high)', fontFamily: 'monospace' }}>{'{{error_message}}'}</code> and more in message templates.
        </p>
      </div>

      {/* Channel list */}
      {isLoading ? (
        <div className="text-sm" style={{ color: 'var(--m3-secondary)' }}>Loading…</div>
      ) : channels.length === 0 ? (
        <div className="rounded-2xl p-12 text-center" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          <span className="material-symbols-outlined" style={{ fontSize: '48px', color: 'var(--m3-outline-variant)' }}>notifications_off</span>
          <p className="mt-3 text-sm font-medium" style={{ color: 'var(--m3-secondary)' }}>No notification channels yet</p>
          <p className="text-xs mt-1" style={{ color: 'var(--m3-secondary)' }}>Add a channel to start receiving alerts.</p>
        </div>
      ) : (
        <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
                {['Name', 'Type', 'Recipient / URL', 'Recovery', 'Status', ''].map((h) => (
                  <th key={h}
                    className={`px-4 py-3 font-mono text-xs uppercase tracking-wider ${h === '' ? 'text-right' : 'text-left'}`}
                    style={{ color: 'var(--m3-secondary)', background: 'var(--m3-surface-container)' }}
                  >{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {channels.map((ch, i) => {
                const cfg = ch.config as Record<string, unknown>
                const recipient = ch.type === 'email' ? String(cfg['to'] ?? '') : String(cfg['url'] ?? '')
                return (
                  <tr key={ch.id}
                    className="transition-colors"
                    style={{ borderTop: i > 0 ? '1px solid var(--m3-outline-variant)' : 'none' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--m3-surface-container)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                  >
                    <td className="px-4 py-3 font-medium" style={{ color: 'var(--m3-on-surface)' }}>{ch.name}</td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5 w-fit px-2 py-0.5 rounded-full text-xs font-medium"
                        style={{ background: ch.type === 'email' ? 'rgba(99,102,241,0.12)' : 'rgba(16,185,129,0.12)', color: ch.type === 'email' ? '#6366f1' : '#10b981' }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>{ch.type === 'email' ? 'mail' : 'webhook'}</span>
                        {ch.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs max-w-xs truncate" style={{ color: 'var(--m3-secondary)' }}>{recipient}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--m3-secondary)' }}>
                      {ch.notifyOnRecovery ? (
                        <span className="flex items-center gap-1" style={{ color: '#10b981' }}>
                          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>check_circle</span> Yes
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1 text-xs font-medium w-fit"
                        style={{ color: ch.enabled ? '#10b981' : 'var(--m3-secondary)' }}
                      >
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: ch.enabled ? '#10b981' : 'var(--m3-outline-variant)' }} />
                        {ch.enabled ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <ActionBtn icon="edit" title="Edit" onClick={() => setEditingChannel(ch)} />
                        <ActionBtn icon="delete" title="Delete" onClick={() => setConfirmDelete(ch)} danger />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modals */}
      {(showCreate || editingChannel) && (
        <ChannelFormModal
          channel={editingChannel}
          onClose={() => { setShowCreate(false); setEditingChannel(null) }}
          onSaved={handleSaved}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete channel"
          message={`Delete "${confirmDelete.name}"? This will also remove it from all monitors.`}
          confirmLabel="Delete"
          onConfirm={() => { deleteMutation.mutate(confirmDelete.id); setConfirmDelete(null) }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {showSmtp && <SmtpModal onClose={() => setShowSmtp(false)} />}
    </div>
  )
}

function ActionBtn({ icon, title, onClick, danger }: { icon: string; title: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
      style={{ color: danger ? 'var(--m3-secondary)' : 'var(--m3-secondary)' }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = danger ? 'var(--m3-error-container)' : 'var(--m3-surface-container-high)'
        ;(e.currentTarget as HTMLButtonElement).style.color = danger ? 'var(--m3-on-error-container)' : 'var(--m3-on-surface)'
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = ''
        ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-secondary)'
      }}
    >
      <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>{icon}</span>
    </button>
  )
}

// ── SMTP Settings Modal ───────────────────────────────────────────────────────

interface VaultSummary  { id: number; name: string }
interface SecretSummary { id: number; name: string; type: 'userpass' | 'value' | 'json' }

function SmtpModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const { data: smtp } = useQuery<SmtpSettings>({
    queryKey: ['smtp-settings'],
    queryFn: () => api.get('/admin/notifications/smtp'),
  })

  const [host, setHost]               = useState('')
  const [port, setPort]               = useState(587)
  const [secure, setSecure]           = useState(false)
  const [fromAddress, setFromAddress] = useState('')
  const [fromName, setFromName]       = useState('BSP Alerts')

  // Credential source
  const [credSource, setCredSource]   = useState<'direct' | 'vault'>('direct')
  const [user, setUser]               = useState('')
  const [password, setPassword]       = useState('')
  const [vault, setVault]             = useState<VaultRef | null>(null)

  // Vault data
  const [vaults, setVaults]                 = useState<VaultSummary[]>([])
  const [secretsByVault, setSecretsByVault] = useState<Record<number, SecretSummary[]>>({})

  const [loaded, setLoaded]     = useState(false)
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState('')
  const [testTo, setTestTo]     = useState('')
  const [testing, setTesting]   = useState(false)
  const [testMsg, setTestMsg]   = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    api.get<VaultSummary[]>('/admin/vaults').then(setVaults).catch(() => {})
  }, [])

  async function loadSecrets(vaultId: number) {
    if (secretsByVault[vaultId]) return
    try {
      const secrets = await api.get<SecretSummary[]>(`/admin/vaults/${vaultId}/secrets`)
      setSecretsByVault((prev) => ({ ...prev, [vaultId]: secrets }))
    } catch { /* ignore */ }
  }

  // Populate when data loads
  useEffect(() => {
    if (!smtp || loaded) return
    setHost(smtp.host)
    setPort(smtp.port)
    setSecure(!!smtp.secure)
    setFromAddress(smtp.fromAddress)
    setFromName(smtp.fromName)
    if (smtp.vault) {
      setCredSource('vault')
      setVault(smtp.vault)
      loadSecrets(smtp.vault.vaultId)
    } else {
      setCredSource('direct')
      setUser(smtp.user)
      setPassword(smtp.password)
    }
    setLoaded(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smtp])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      await api.put('/admin/notifications/smtp', {
        host, port, secure: secure ? 1 : 0, fromAddress, fromName,
        user: credSource === 'direct' ? user : '',
        password: credSource === 'direct' ? password : '',
        vault: credSource === 'vault' ? vault : null,
      })
      qc.invalidateQueries({ queryKey: ['smtp-settings'] })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    if (!testTo) return
    setTesting(true)
    setTestMsg(null)
    try {
      await api.post('/admin/notifications/smtp/test', { to: testTo })
      setTestMsg({ ok: true, text: `Test email sent to ${testTo}` })
    } catch (err) {
      setTestMsg({ ok: false, text: err instanceof Error ? err.message : 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  const selectedSecret = vault?.vaultId && vault?.secretId
    ? (secretsByVault[vault.vaultId] ?? []).find((s) => s.id === vault.secretId)
    : undefined

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.55)', overflowY: 'auto' }}>
      <div style={{ display: 'flex', minHeight: '100%', alignItems: 'flex-start', justifyContent: 'center', padding: '16px' }}>
        <div className="rounded-2xl w-full max-w-lg my-8"
          style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          <div className="flex items-center justify-between px-6 py-5" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
            <h3 className="font-headline font-bold text-lg" style={{ color: 'var(--m3-on-surface)' }}>SMTP Settings</h3>
            <button onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-xl leading-none"
              style={{ color: 'var(--m3-secondary)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--m3-surface-container-high)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '' }}
            >×</button>
          </div>

          <form onSubmit={handleSave} className="p-6 space-y-4">
            {error && (
              <div className="rounded-lg px-4 py-3 text-sm" style={{ background: 'rgba(255,77,106,0.08)', border: '1px solid rgba(255,77,106,0.2)', color: 'var(--m3-down)' }}>{error}</div>
            )}
            <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>Used by all email notification channels.</p>

            {/* Host + Port */}
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <SmtpField label="Host">
                  <input value={host} onChange={(e) => setHost(e.target.value)} className="input-sig" placeholder="smtp.example.com" />
                </SmtpField>
              </div>
              <SmtpField label="Port">
                <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} className="input-sig" />
              </SmtpField>
            </div>

            {/* TLS toggle */}
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <div className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0"
                style={{ background: secure ? 'var(--m3-primary)' : 'var(--m3-outline-variant)' }}
                onClick={() => setSecure((v) => !v)}
              >
                <div className="absolute top-0.5 w-4 h-4 rounded-full transition-all"
                  style={{ background: secure ? 'var(--m3-on-primary)' : 'var(--m3-secondary)', left: secure ? '22px' : '2px' }} />
              </div>
              <span className="text-sm" style={{ color: 'var(--m3-on-surface-variant)' }}>Use TLS/SSL (port 465)</span>
            </label>

            <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

            {/* Credentials source toggle */}
            <div>
              <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Credentials</label>
              <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--m3-outline-variant)', width: 'fit-content' }}>
                {(['direct', 'vault'] as const).map((src) => (
                  <button key={src} type="button"
                    onClick={() => {
                      setCredSource(src)
                      if (src === 'vault' && vaults[0]) {
                        loadSecrets(vaults[0].id)
                        if (!vault) setVault({ vaultId: vaults[0].id, secretId: 0 })
                      }
                    }}
                    className="px-4 py-1.5 text-xs font-medium transition-all"
                    style={{
                      background: credSource === src ? 'var(--m3-primary-fixed)' : 'transparent',
                      color:      credSource === src ? 'var(--m3-primary)' : 'var(--m3-secondary)',
                    }}
                  >
                    {src === 'direct' ? 'Direct input' : 'From Vault'}
                  </button>
                ))}
              </div>
            </div>

            {/* Direct credentials */}
            {credSource === 'direct' && (
              <>
                <div className="flex items-start gap-2 rounded-lg px-3 py-2"
                  style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.20)' }}>
                  <span style={{ color: '#eab308', lineHeight: '20px' }}>⚠</span>
                  <p className="text-xs" style={{ color: 'var(--m3-on-surface-variant)' }}>
                    For security, store credentials in Vault rather than entering them directly here.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <SmtpField label="Username">
                    <input value={user} onChange={(e) => setUser(e.target.value)} className="input-sig" placeholder="user@example.com" autoComplete="off" />
                  </SmtpField>
                  <SmtpField label="Password">
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="input-sig" autoComplete="new-password" placeholder="••••••••" />
                  </SmtpField>
                </div>
              </>
            )}

            {/* Vault credentials */}
            {credSource === 'vault' && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <SmtpField label="Vault">
                    <select className="input-sig" value={vault?.vaultId || ''}
                      onChange={(e) => {
                        const id = Number(e.target.value)
                        loadSecrets(id)
                        setVault({ vaultId: id, secretId: 0 })
                      }}
                    >
                      <option value="">— select vault —</option>
                      {vaults.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                  </SmtpField>
                  <SmtpField label="Secret">
                    <select className="input-sig" value={vault?.secretId || ''}
                      disabled={!vault?.vaultId}
                      onChange={(e) => setVault((v) => ({ vaultId: v!.vaultId, secretId: Number(e.target.value) }))}
                    >
                      <option value="">— select secret —</option>
                      {(vault?.vaultId ? (secretsByVault[vault.vaultId] ?? []) : []).map((s) => (
                        <option key={s.id} value={s.id}>{s.name} ({s.type})</option>
                      ))}
                    </select>
                  </SmtpField>
                </div>

                {selectedSecret?.type === 'userpass' && (
                  <p className="text-xs rounded-lg px-3 py-2" style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)' }}>
                    Auto-mapped: <strong>username</strong> → SMTP user, <strong>password</strong> → SMTP password.
                  </p>
                )}

                {selectedSecret?.type === 'json' && vault?.secretId && (
                  <div className="space-y-2">
                    <p className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>JSON Field Mapping</p>
                    {(['username', 'password'] as const).map((field) => (
                      <div key={field} className="grid items-center gap-3" style={{ gridTemplateColumns: '90px 1fr' }}>
                        <span className="text-xs font-medium" style={{ color: 'var(--m3-on-surface-variant)' }}>{field}</span>
                        <input className="input-sig text-xs" placeholder={`JSON key (e.g. "${field}")`}
                          value={vault?.fieldMapping?.[field] ?? ''}
                          onChange={(e) => setVault((v) => ({
                            ...v!,
                            fieldMapping: { ...(v?.fieldMapping ?? {}), [field]: e.target.value },
                          }))}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {vaults.length === 0 && (
                  <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>No vaults found. Create one in the Vault section first.</p>
                )}
              </div>
            )}

            <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

            {/* From */}
            <div className="grid grid-cols-2 gap-3">
              <SmtpField label="From Address">
                <input value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} className="input-sig" placeholder="alerts@example.com" />
              </SmtpField>
              <SmtpField label="From Name">
                <input value={fromName} onChange={(e) => setFromName(e.target.value)} className="input-sig" />
              </SmtpField>
            </div>

            <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

            {/* Test email */}
            <div className="space-y-2">
              <label className="block font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Send Test Email</label>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder="recipient@example.com"
                  className="input-sig flex-1"
                />
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={testing || !testTo}
                  className="px-3 py-2 text-sm font-semibold rounded-lg transition-all flex items-center gap-1.5 flex-shrink-0"
                  style={{
                    background: 'var(--m3-surface-container-high)',
                    color: testing || !testTo ? 'var(--m3-secondary)' : 'var(--m3-on-surface)',
                    border: '1px solid var(--m3-outline-variant)',
                    opacity: !testTo ? 0.5 : 1,
                  }}
                >
                  {testing
                    ? <><span className="material-symbols-outlined animate-spin" style={{ fontSize: '15px' }}>progress_activity</span> Sending…</>
                    : <><span className="material-symbols-outlined" style={{ fontSize: '15px' }}>send</span> Send</>
                  }
                </button>
              </div>
              {testMsg && (
                <div className="rounded-lg px-3 py-2 text-xs"
                  style={{
                    background: testMsg.ok ? 'rgba(34,197,94,0.08)' : 'rgba(255,77,106,0.08)',
                    border: `1px solid ${testMsg.ok ? 'rgba(34,197,94,0.25)' : 'rgba(255,77,106,0.2)'}`,
                    color: testMsg.ok ? '#22c55e' : 'var(--m3-down)',
                  }}
                >{testMsg.text}</div>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-1">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg" style={{ color: 'var(--m3-secondary)' }}>Cancel</button>
              <button type="submit" disabled={saving}
                className="px-4 py-2 text-sm font-semibold rounded-lg transition-all"
                style={{ background: saving ? 'var(--m3-surface-container-high)' : 'var(--m3-primary)', color: saving ? 'var(--m3-secondary)' : 'var(--m3-on-primary)', opacity: saving ? 0.7 : 1 }}
              >
                {saving ? 'Saving…' : 'Save Settings'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function SmtpField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>{label}</label>
      {children}
    </div>
  )
}
