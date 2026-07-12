import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { ConfirmModal } from '../components/ConfirmModal'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Vault {
  id: number
  name: string
  type: 'local'
  description: string | null
  createdAt: number
  updatedAt: number
}

interface VaultSecret {
  id: number
  vaultId: number
  name: string
  type: 'userpass' | 'value' | 'json'
  createdAt: number
  updatedAt: number
}

interface RevealedSecret {
  id: number
  name: string
  type: 'userpass' | 'value' | 'json'
  value: { username?: string; password?: string; value?: string }
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function VaultPage() {
  const qc = useQueryClient()
  const [selectedVaultId, setSelectedVaultId] = useState<number | null>(null)
  const [showCreateVault, setShowCreateVault] = useState(false)
  const [showCreateSecret, setShowCreateSecret] = useState(false)
  const [revealedSecret, setRevealedSecret] = useState<RevealedSecret | null>(null)
  const [revealing, setRevealing] = useState<number | null>(null)
  const [deleteVaultTarget, setDeleteVaultTarget] = useState<Vault | null>(null)
  const [deleteSecretTarget, setDeleteSecretTarget] = useState<VaultSecret | null>(null)

  const { data: vaults = [] } = useQuery<Vault[]>({
    queryKey: ['vaults'],
    queryFn: () => api.get('/admin/vaults'),
  })

  const { data: secrets = [] } = useQuery<VaultSecret[]>({
    queryKey: ['vault-secrets', selectedVaultId],
    queryFn: () => api.get(`/admin/vaults/${selectedVaultId}/secrets`),
    enabled: selectedVaultId !== null,
  })

  const deleteVault = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/vaults/${id}`),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['vaults'] })
      if (selectedVaultId === id) setSelectedVaultId(null)
    },
  })

  const deleteSecret = useMutation({
    mutationFn: ({ vaultId, secretId }: { vaultId: number; secretId: number }) =>
      api.delete(`/admin/vaults/${vaultId}/secrets/${secretId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vault-secrets', selectedVaultId] }),
  })

  async function handleReveal(secret: VaultSecret) {
    setRevealing(secret.id)
    try {
      const data = await api.get<RevealedSecret>(`/admin/vaults/${secret.vaultId}/secrets/${secret.id}/reveal`)
      setRevealedSecret(data)
    } finally {
      setRevealing(null)
    }
  }

  const selectedVault = vaults.find((v) => v.id === selectedVaultId)

  return (
    <div className="flex h-full overflow-hidden fade-up">
      {/* ── Left sidebar: vault list ── */}
      <aside className="w-64 flex flex-col shrink-0 overflow-y-auto" style={{ borderRight: '1px solid var(--m3-outline-variant)', background: 'var(--m3-surface-container-low)' }}>
        <div className="flex items-center justify-between px-4 py-4" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
          <div>
            <h1 className="font-headline font-bold text-base" style={{ color: 'var(--m3-on-surface)' }}>Vaults</h1>
            <p className="text-xs mt-0.5" style={{ color: 'var(--m3-secondary)' }}>{vaults.length} vault{vaults.length !== 1 ? 's' : ''}</p>
          </div>
          <button
            onClick={() => setShowCreateVault(true)}
            className="btn-primary w-8 h-8 flex items-center justify-center rounded-xl transition-colors text-lg leading-none font-bold"
            style={{ background: 'var(--m3-primary)', color: 'var(--m3-on-primary)' }}
            title="Create vault"
          >
            +
          </button>
        </div>

        <div className="flex-1 p-2 space-y-1">
          {/* Local vaults */}
          {vaults.map((vault) => (
            <VaultRow
              key={vault.id}
              vault={vault}
              isSelected={selectedVaultId === vault.id}
              onClick={() => setSelectedVaultId(vault.id)}
              onDelete={() => setDeleteVaultTarget(vault)}
            />
          ))}
          {vaults.length === 0 && (
            <p className="text-xs text-center py-6" style={{ color: 'var(--m3-secondary)' }}>No vaults yet</p>
          )}

          {/* Azure KeyVault — coming soon */}
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
            <p className="text-[10px] uppercase tracking-wider px-2 mb-2" style={{ color: 'var(--m3-secondary)' }}>External</p>
            <div
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl opacity-40 cursor-not-allowed select-none"
              style={{ background: 'var(--m3-surface-container)' }}
              title="Coming soon"
            >
              <span className="material-symbols-outlined shrink-0" style={{ fontSize: '18px', color: 'var(--m3-secondary)' }}>cloud</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate" style={{ color: 'var(--m3-on-surface)' }}>Azure Key Vault</p>
                <p className="text-[10px]" style={{ color: 'var(--m3-secondary)' }}>Coming soon</p>
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* ── Right panel: secrets ── */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {selectedVault ? (
          <>
            <div className="flex items-center justify-between px-6 py-4 shrink-0" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
              <div>
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined" style={{ fontSize: '20px', color: 'var(--m3-primary)' }}>lock</span>
                  <h2 className="font-headline font-bold text-lg" style={{ color: 'var(--m3-on-surface)' }}>{selectedVault.name}</h2>
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wide" style={{ background: 'var(--m3-primary-fixed)', color: 'var(--m3-primary)' }}>LOCAL</span>
                </div>
                {selectedVault.description && (
                  <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>{selectedVault.description}</p>
                )}
              </div>
              <button
                onClick={() => setShowCreateSecret(true)}
                className="btn-primary flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-all"
                style={{ background: 'var(--m3-primary)', color: 'var(--m3-on-primary)' }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>add</span>
                New Secret
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {secrets.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-4" style={{ color: 'var(--m3-secondary)' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '48px', opacity: 0.4 }}>key_off</span>
                  <p className="text-sm">No secrets in this vault</p>
                  <button
                    onClick={() => setShowCreateSecret(true)}
                    className="text-sm font-medium px-4 py-2 rounded-xl"
                    style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-on-surface)' }}
                  >
                    Add first secret
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {secrets.map((secret) => (
                    <SecretRow
                      key={secret.id}
                      secret={secret}
                      isRevealing={revealing === secret.id}
                      onReveal={() => handleReveal(secret)}
                      onDelete={() => setDeleteSecretTarget(secret)}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: 'var(--m3-secondary)' }}>
            <span className="material-symbols-outlined" style={{ fontSize: '56px', opacity: 0.3 }}>shield_lock</span>
            <p className="text-sm">Select a vault to view its secrets</p>
          </div>
        )}
      </main>

      {/* ── Modals ── */}
      {showCreateVault && (
        <CreateVaultModal
          onClose={() => setShowCreateVault(false)}
          onCreated={(v) => { qc.invalidateQueries({ queryKey: ['vaults'] }); setSelectedVaultId(v.id); setShowCreateVault(false) }}
        />
      )}
      {showCreateSecret && selectedVaultId !== null && (
        <CreateSecretModal
          vaultId={selectedVaultId}
          onClose={() => setShowCreateSecret(false)}
          onCreated={() => { qc.invalidateQueries({ queryKey: ['vault-secrets', selectedVaultId] }); setShowCreateSecret(false) }}
        />
      )}
      {revealedSecret && (
        <RevealModal secret={revealedSecret} onClose={() => setRevealedSecret(null)} />
      )}
      {deleteVaultTarget && (
        <DeleteVaultModal
          vault={deleteVaultTarget}
          secretCount={deleteVaultTarget.id === selectedVaultId ? secrets.length : null}
          onClose={() => setDeleteVaultTarget(null)}
          onConfirm={() => {
            deleteVault.mutate(deleteVaultTarget.id)
            setDeleteVaultTarget(null)
          }}
        />
      )}
      {deleteSecretTarget && (
        <ConfirmModal
          title="Delete secret"
          message={`Delete secret "${deleteSecretTarget.name}"? This action cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={() => {
            deleteSecret.mutate({ vaultId: deleteSecretTarget.vaultId, secretId: deleteSecretTarget.id })
            setDeleteSecretTarget(null)
          }}
          onCancel={() => setDeleteSecretTarget(null)}
        />
      )}
    </div>
  )
}

// ── Vault row ──────────────────────────────────────────────────────────────────

function VaultRow({ vault, isSelected, onClick, onDelete }: {
  vault: Vault
  isSelected: boolean
  onClick: () => void
  onDelete: () => void
}) {
  return (
    <div
      className="group flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-colors"
      style={{
        background: isSelected ? 'var(--m3-surface-container-lowest)' : 'transparent',
        boxShadow: isSelected ? '0 1px 4px rgba(19,27,46,0.08)' : 'none',
      }}
      onClick={onClick}
      onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--m3-surface-container)' }}
      onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <span className="material-symbols-outlined shrink-0" style={{ fontSize: '18px', color: isSelected ? 'var(--m3-primary)' : 'var(--m3-secondary)', fontVariationSettings: isSelected ? "'FILL' 1" : "'FILL' 0" }}>lock</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate" style={{ color: 'var(--m3-on-surface)' }}>{vault.name}</p>
        {vault.description && (
          <p className="text-[10px] truncate" style={{ color: 'var(--m3-secondary)' }}>{vault.description}</p>
        )}
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded-lg transition-all text-xs shrink-0"
        style={{ color: 'var(--m3-secondary)' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--m3-error-container)'; (e.currentTarget as HTMLElement).style.color = 'var(--m3-on-error-container)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; (e.currentTarget as HTMLElement).style.color = 'var(--m3-secondary)' }}
      >
        ×
      </button>
    </div>
  )
}

// ── Secret row ─────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = { userpass: 'User/Pass', value: 'Value', json: 'JSON' }
const TYPE_ICONS: Record<string, string> = { userpass: 'person', value: 'key', json: 'data_object' }

function SecretRow({ secret, isRevealing, onReveal, onDelete }: {
  secret: VaultSecret
  isRevealing: boolean
  onReveal: () => void
  onDelete: () => void
}) {
  return (
    <div
      className="flex items-center gap-4 px-4 py-3 rounded-xl"
      style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}
    >
      <span className="material-symbols-outlined shrink-0" style={{ fontSize: '20px', color: 'var(--m3-secondary)' }}>{TYPE_ICONS[secret.type] ?? 'key'}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold" style={{ color: 'var(--m3-on-surface)' }}>{secret.name}</p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--m3-secondary)' }}>
          {TYPE_LABELS[secret.type]} · Updated {new Date(secret.updatedAt).toLocaleDateString()}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onReveal}
          disabled={isRevealing}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-all"
          style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-on-surface)', opacity: isRevealing ? 0.6 : 1 }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>{isRevealing ? 'progress_activity' : 'visibility'}</span>
          {isRevealing ? 'Loading…' : 'Reveal'}
        </button>
        <button
          onClick={onDelete}
          className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg transition-all"
          style={{ color: 'var(--m3-secondary)' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--m3-error-container)'; (e.currentTarget as HTMLElement).style.color = 'var(--m3-on-error-container)' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; (e.currentTarget as HTMLElement).style.color = 'var(--m3-secondary)' }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>delete</span>
        </button>
      </div>
    </div>
  )
}

// ── Create Vault modal ─────────────────────────────────────────────────────────

// ── Delete Vault modal (with checkbox when secrets exist) ─────────────────────

function DeleteVaultModal({ vault, secretCount, onClose, onConfirm }: {
  vault: Vault
  secretCount: number | null  // null = unknown (vault not currently selected/loaded)
  onClose: () => void
  onConfirm: () => void
}) {
  const hasSecrets = secretCount === null || secretCount > 0
  const [confirmed, setConfirmed] = useState(false)

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 9999, background: 'rgba(0,0,0,0.4)' }}
      onClick={onClose}
    >
      <div
        className="rounded-2xl p-6 w-full max-w-sm mx-4 space-y-4"
        style={{ background: 'var(--m3-surface-container-lowest)', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="material-symbols-outlined mt-0.5 shrink-0" style={{ fontSize: '22px', color: 'var(--m3-error)' }}>warning</span>
          <div>
            <h3 className="font-headline text-lg font-bold" style={{ color: 'var(--m3-on-surface)' }}>
              Delete vault
            </h3>
            <p className="text-sm mt-1" style={{ color: 'var(--m3-on-surface-variant)' }}>
              You are about to delete <span className="font-semibold" style={{ color: 'var(--m3-on-surface)' }}>{vault.name}</span>.
            </p>
          </div>
        </div>

        {hasSecrets && (
          <div className="rounded-xl px-4 py-3 space-y-3" style={{ background: 'var(--m3-error-container)' }}>
            <p className="text-sm font-medium" style={{ color: 'var(--m3-on-error-container)' }}>
              {secretCount !== null && secretCount > 0
                ? `This vault contains ${secretCount} secret${secretCount !== 1 ? 's' : ''}. All secrets will be permanently deleted.`
                : 'This vault may contain secrets. All secrets will be permanently deleted.'}
            </p>
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="w-4 h-4 rounded accent-red-500"
              />
              <span className="text-sm font-medium" style={{ color: 'var(--m3-on-error-container)' }}>
                I understand all secrets will be permanently deleted
              </span>
            </label>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-full text-sm font-bold"
            style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={hasSecrets && !confirmed}
            className="px-5 py-2 rounded-full text-sm font-bold transition-all"
            style={{
              background: hasSecrets && !confirmed ? 'var(--m3-surface-container-high)' : 'var(--m3-error-container)',
              color: hasSecrets && !confirmed ? 'var(--m3-secondary)' : 'var(--m3-on-error-container)',
              border: hasSecrets && !confirmed ? '1px solid transparent' : '1px solid color-mix(in srgb, var(--m3-error) 45%, transparent)',
              cursor: hasSecrets && !confirmed ? 'not-allowed' : 'pointer',
            }}
          >
            Delete vault
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── Create Vault modal ─────────────────────────────────────────────────────────

function CreateVaultModal({ onClose, onCreated }: { onClose: () => void; onCreated: (v: Vault) => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const vault = await api.post<Vault>('/admin/vaults', { name, description: description || undefined })
      onCreated(vault)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create vault')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal title="Create Vault" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <Field label="Vault name">
          <input value={name} onChange={(e) => setName(e.target.value)} required className="input-sig" placeholder="My Credentials" autoFocus />
        </Field>
        <Field label="Description (optional)">
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="input-sig" placeholder="What this vault stores…" />
        </Field>
        <Field label="Type">
          <div className="flex items-center gap-3">
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-lg flex-1"
              style={{
                background: 'var(--m3-surface-container-high)',
                border: '1px solid color-mix(in srgb, var(--m3-primary) 45%, var(--m3-outline-variant))',
                boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--m3-primary) 16%, transparent)',
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px', color: 'var(--m3-primary)' }}>storage</span>
              <span className="text-sm font-medium" style={{ color: 'var(--m3-primary)' }}>Local</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg flex-1 opacity-40 cursor-not-allowed" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }} title="Coming soon">
              <span className="material-symbols-outlined" style={{ fontSize: '16px', color: 'var(--m3-secondary)' }}>cloud</span>
              <div>
                <span className="text-sm" style={{ color: 'var(--m3-secondary)' }}>Azure Key Vault</span>
                <span className="text-[10px] block" style={{ color: 'var(--m3-secondary)' }}>Coming soon</span>
              </div>
            </div>
          </div>
        </Field>
        <ModalActions onClose={onClose} loading={loading} submitLabel="Create Vault" />
      </form>
    </Modal>
  )
}

// ── Create Secret modal ────────────────────────────────────────────────────────

function CreateSecretModal({ vaultId, onClose, onCreated }: { vaultId: number; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [type, setType] = useState<'userpass' | 'value' | 'json'>('userpass')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [value, setValue] = useState('')
  const [json, setJson] = useState('')
  const [jsonError, setJsonError] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function validateJson(v: string) {
    try { JSON.parse(v); setJsonError('') } catch { setJsonError('Invalid JSON') }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (type === 'json' && jsonError) return
    setError('')
    setLoading(true)
    try {
      const body: Record<string, unknown> = { name, type }
      if (type === 'userpass') body['userpass'] = { username, password }
      if (type === 'value') body['value'] = value
      if (type === 'json') body['json'] = json
      await api.post(`/admin/vaults/${vaultId}/secrets`, body)
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create secret')
    } finally {
      setLoading(false)
    }
  }

  const types: { value: 'userpass' | 'value' | 'json'; label: string; desc: string }[] = [
    { value: 'userpass', label: 'User / Password', desc: 'Username + password pair' },
    { value: 'value',    label: 'Secure Value',    desc: 'Token, connection string…' },
    { value: 'json',     label: 'JSON',             desc: 'Arbitrary JSON object' },
  ]

  return (
    <Modal title="New Secret" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <Field label="Secret name">
          <input value={name} onChange={(e) => setName(e.target.value)} required className="input-sig" placeholder="my-api-key" autoFocus />
        </Field>

        <Field label="Type">
          <div className="grid grid-cols-3 gap-2">
            {types.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setType(t.value)}
                className={`px-3 py-2.5 rounded-xl text-left transition-all ${type === t.value ? 'selection-active' : ''}`}
                style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)', border: '1px solid var(--m3-outline-variant)' }}
              >
                <p className="text-xs font-bold">{t.label}</p>
                <p className="text-[10px] mt-0.5 opacity-80">{t.desc}</p>
              </button>
            ))}
          </div>
        </Field>

        {type === 'userpass' && (
          <>
            <Field label="Username">
              <input value={username} onChange={(e) => setUsername(e.target.value)} required className="input-sig" placeholder="admin" autoComplete="off" />
            </Field>
            <Field label="Password">
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className="input-sig" placeholder="••••••••" autoComplete="new-password" />
            </Field>
          </>
        )}
        {type === 'value' && (
          <Field label="Value">
            <input value={value} onChange={(e) => setValue(e.target.value)} required className="input-sig" placeholder="Bearer eyJ…" autoComplete="off" />
          </Field>
        )}
        {type === 'json' && (
          <Field label={`JSON${jsonError ? ` — ${jsonError}` : ''}`}>
            <textarea
              value={json}
              onChange={(e) => { setJson(e.target.value); validateJson(e.target.value) }}
              required
              rows={5}
              className="input-sig font-mono text-xs resize-none"
              placeholder={'{\n  "key": "value"\n}'}
              style={{ borderColor: jsonError ? 'var(--m3-error)' : undefined }}
            />
          </Field>
        )}

        <ModalActions onClose={onClose} loading={loading} submitLabel="Save Secret" />
      </form>
    </Modal>
  )
}

// ── Reveal modal ───────────────────────────────────────────────────────────────

function RevealModal({ secret, onClose }: { secret: RevealedSecret; onClose: () => void }) {
  const [showPassword, setShowPassword] = useState(false)

  return (
    <Modal title={secret.name} onClose={onClose}>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full" style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-secondary)' }}>
            {TYPE_LABELS[secret.type]}
          </span>
        </div>

        {secret.type === 'userpass' && (
          <>
            <RevealField label="Username" value={secret.value.username ?? ''} mono />
            <RevealField label="Password" value={secret.value.password ?? ''} hidden={!showPassword} mono
              action={<button onClick={() => setShowPassword((p) => !p)} className="text-xs" style={{ color: 'var(--m3-primary)' }}>{showPassword ? 'Hide' : 'Show'}</button>}
            />
          </>
        )}
        {(secret.type === 'value') && (
          <RevealField label="Value" value={secret.value.value ?? ''} mono />
        )}
        {secret.type === 'json' && (
          <div>
            <p className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--m3-secondary)' }}>JSON</p>
            <pre className="text-xs p-3 rounded-xl overflow-auto max-h-64" style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-on-surface)', fontFamily: 'monospace' }}>
              {JSON.stringify(JSON.parse(secret.value.value ?? '{}'), null, 2)}
            </pre>
          </div>
        )}

        <div className="pt-2 flex justify-end">
          <button onClick={onClose} className="text-sm font-medium px-4 py-2 rounded-xl" style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-on-surface)' }}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}

function RevealField({ label, value, mono, hidden, action }: { label: string; value: string; mono?: boolean; hidden?: boolean; action?: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>{label}</p>
        {action}
      </div>
      <div className="px-3 py-2 rounded-xl flex items-center justify-between gap-2" style={{ background: 'var(--m3-surface-container-high)' }}>
        <span className={`text-sm flex-1 break-all ${mono ? 'font-mono' : ''}`} style={{ color: 'var(--m3-on-surface)', filter: hidden ? 'blur(6px)' : 'none', userSelect: hidden ? 'none' : undefined }}>
          {value || '(empty)'}
        </span>
        {!hidden && (
          <button
            onClick={() => navigator.clipboard.writeText(value)}
            className="shrink-0 text-xs px-2 py-1 rounded-lg"
            style={{ color: 'var(--m3-secondary)', background: 'var(--m3-surface-container)' }}
            title="Copy"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>content_copy</span>
          </button>
        )}
      </div>
    </div>
  )
}

// ── Shared primitives ──────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div className="w-full max-w-md rounded-2xl" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
          <h3 className="font-headline font-bold text-lg" style={{ color: 'var(--m3-on-surface)' }}>{title}</h3>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg text-xl leading-none" style={{ color: 'var(--m3-secondary)' }}>×</button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider mb-1.5 font-semibold" style={{ color: 'var(--m3-secondary)' }}>{label}</label>
      {children}
    </div>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="px-4 py-3 rounded-xl text-sm" style={{ background: 'var(--m3-error-container)', color: 'var(--m3-on-error-container)' }}>
      {message}
    </div>
  )
}

function ModalActions({ onClose, loading, submitLabel }: { onClose: () => void; loading: boolean; submitLabel: string }) {
  return (
    <div className="flex justify-end gap-3 pt-2">
      <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-xl" style={{ color: 'var(--m3-secondary)' }}>Cancel</button>
      <button type="submit" disabled={loading} className="btn-primary px-4 py-2 text-sm font-semibold rounded-xl transition-all" style={{ opacity: loading ? 0.7 : 1 }}>
        {loading ? 'Saving…' : submitLabel}
      </button>
    </div>
  )
}
