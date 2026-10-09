import { useId, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { ConfirmModal } from '../components/ConfirmModal'
import { CopyButton } from '../components/CopyButton'
import { Modal, ModalShell } from '../components/ModalShell'
import { Alert, EmptyState, EmptyStateLink, ErrorState, Field, LoadingState, useToast } from '../components/ui'
import { formatDate } from '../lib/dateFormat'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Vault {
  id: number
  name: string
  type: 'local' | 'hashicorp'
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
  /** HashiCorp vaults only: where in Vault the value was read from. */
  source?: { path: string; key?: string }
}

interface HashicorpConnection {
  address: string
  namespace: string
  mount: string
  authMethod: 'token' | 'approle'
  approleMount: string
  roleId: string
  caCert: string
  hasToken: boolean
  hasSecretId: boolean
}

/** What the connection form edits; credentials stay blank when unchanged. */
interface ConnectionForm {
  address: string
  namespace: string
  mount: string
  authMethod: 'token' | 'approle'
  token: string
  roleId: string
  secretId: string
  approleMount: string
  caCert: string
}

const EMPTY_CONNECTION: ConnectionForm = {
  address: '', namespace: '', mount: 'secret', authMethod: 'token', token: '', roleId: '', secretId: '', approleMount: 'approle', caCert: '',
}

const VAULT_TYPE_LABELS: Record<Vault['type'], string> = { local: 'LOCAL', hashicorp: 'HASHICORP VAULT' }
const VAULT_TYPE_ICONS: Record<Vault['type'], string> = { local: 'lock', hashicorp: 'vpn_key' }

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function VaultPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const [selectedVaultId, setSelectedVaultId] = useState<number | null>(null)
  const [showCreateVault, setShowCreateVault] = useState(false)
  const [showCreateSecret, setShowCreateSecret] = useState(false)
  const [revealedSecret, setRevealedSecret] = useState<RevealedSecret | null>(null)
  const [revealing, setRevealing] = useState<number | null>(null)
  const [deleteVaultTarget, setDeleteVaultTarget] = useState<Vault | null>(null)
  const [deleteSecretTarget, setDeleteSecretTarget] = useState<VaultSecret | null>(null)
  const [showConnection, setShowConnection] = useState(false)

  const vaultsQuery = useQuery<Vault[]>({
    queryKey: ['vaults'],
    queryFn: () => api.get('/admin/vaults'),
  })
  const vaults = vaultsQuery.data ?? []

  const secretsQuery = useQuery<VaultSecret[]>({
    queryKey: ['vault-secrets', selectedVaultId],
    queryFn: () => api.get(`/admin/vaults/${selectedVaultId}/secrets`),
    enabled: selectedVaultId !== null,
  })
  const secrets = secretsQuery.data ?? []

  const deleteVault = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/vaults/${id}`),
    onSuccess: (_, id) => {
      const vault = vaults.find((v) => v.id === id)
      toast.success(vault ? `Deleted vault "${vault.name}".` : 'Vault deleted.')
      setDeleteVaultTarget(null)
      qc.invalidateQueries({ queryKey: ['vaults'] })
      if (selectedVaultId === id) setSelectedVaultId(null)
    },
    onError: (err) => {
      setDeleteVaultTarget(null)
      toast.error(errorMessage(err, 'Failed to delete vault'))
    },
  })

  const deleteSecret = useMutation({
    mutationFn: ({ vaultId, secretId }: { vaultId: number; secretId: number }) =>
      api.delete(`/admin/vaults/${vaultId}/secrets/${secretId}`),
    onSuccess: () => {
      toast.success('Secret deleted.')
      setDeleteSecretTarget(null)
      qc.invalidateQueries({ queryKey: ['vault-secrets', selectedVaultId] })
    },
    onError: (err) => {
      setDeleteSecretTarget(null)
      toast.error(errorMessage(err, 'Failed to delete secret'))
    },
  })

  const testConnection = useMutation({
    mutationFn: (id: number) => api.post<{ ok: boolean; ttlSeconds: number | null }>(`/admin/vaults/${id}/test`),
    onSuccess: (res) => toast.success(res.ttlSeconds ? `Connected to HashiCorp Vault. Token valid for ${res.ttlSeconds} s.` : 'Connected to HashiCorp Vault.'),
    onError: (err) => toast.error(`Connection failed: ${errorMessage(err, 'unknown error')}`),
  })

  async function handleReveal(secret: VaultSecret) {
    setRevealing(secret.id)
    try {
      const data = await api.get<RevealedSecret>(`/admin/vaults/${secret.vaultId}/secrets/${secret.id}/reveal`)
      setRevealedSecret(data)
    } catch (err) {
      toast.error(`Could not reveal "${secret.name}": ${errorMessage(err, 'unknown error')}`)
    } finally {
      setRevealing(null)
    }
  }

  const selectedVault = vaults.find((v) => v.id === selectedVaultId)

  return (
    <div className="flex flex-col md:flex-row h-full md:overflow-hidden fade-up">
      {/* ── Left sidebar: vault list ── */}
      <aside
        aria-label="Vaults"
        className="w-full md:w-64 flex flex-col shrink-0 md:overflow-y-auto border-b md:border-b-0 md:border-r"
        style={{ borderColor: 'var(--m3-outline-variant)', background: 'var(--m3-surface-container-low)' }}
      >
        <div className="flex items-center justify-between px-4 py-4" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
          <div>
            <h1 className="font-headline font-bold text-base" style={{ color: 'var(--m3-on-surface)' }}>Vaults</h1>
            {vaultsQuery.data && (
              <p className="text-xs mt-0.5" style={{ color: 'var(--m3-secondary)' }}>{vaults.length} vault{vaults.length !== 1 ? 's' : ''}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowCreateVault(true)}
            className="btn btn-primary btn-sm px-2"
            aria-label="Create vault"
            title="Create vault"
          >
            <span className="material-symbols-outlined" aria-hidden="true">add</span>
          </button>
        </div>

        <div className="flex-1 p-2 space-y-1">
          {/* Local vaults */}
          {vaultsQuery.isLoading ? (
            <LoadingState label="Loading vaults…" className="py-6" />
          ) : vaultsQuery.isError ? (
            <ErrorState message="Could not load vaults." onRetry={() => void vaultsQuery.refetch()} className="px-3 py-6" />
          ) : (
            <>
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
            </>
          )}

          {/* Azure KeyVault — coming soon */}
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
            <p className="text-[10px] uppercase tracking-wider px-2 mb-2" style={{ color: 'var(--m3-secondary)' }}>External</p>
            <div
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl opacity-40 cursor-not-allowed select-none"
              style={{ background: 'var(--m3-surface-container)' }}
              title="Coming soon"
            >
              <span className="material-symbols-outlined shrink-0" aria-hidden="true" style={{ fontSize: '18px', color: 'var(--m3-secondary)' }}>cloud</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate" style={{ color: 'var(--m3-on-surface)' }}>Azure Key Vault</p>
                <p className="text-[10px]" style={{ color: 'var(--m3-secondary)' }}>Coming soon</p>
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* ── Right panel: secrets ── */}
      <main className="flex-1 flex flex-col md:overflow-hidden min-w-0">
        {selectedVault ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 md:px-6 py-4 shrink-0" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '20px', color: 'var(--m3-primary)' }}>{VAULT_TYPE_ICONS[selectedVault.type]}</span>
                  <h2 className="font-headline font-bold text-lg break-all" style={{ color: 'var(--m3-on-surface)' }}>{selectedVault.name}</h2>
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wide" style={{ background: 'var(--m3-primary-fixed)', color: 'var(--m3-primary)' }}>{VAULT_TYPE_LABELS[selectedVault.type]}</span>
                </div>
                {selectedVault.description && (
                  <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>{selectedVault.description}</p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {selectedVault.type === 'hashicorp' && (
                  <>
                    <button type="button" onClick={() => testConnection.mutate(selectedVault.id)} disabled={testConnection.isPending} className="btn btn-secondary">
                      <span className="material-symbols-outlined" aria-hidden="true">network_check</span>
                      {testConnection.isPending ? 'Testing…' : 'Test connection'}
                    </button>
                    <button type="button" onClick={() => setShowConnection(true)} className="btn btn-secondary">
                      <span className="material-symbols-outlined" aria-hidden="true">settings</span>
                      Connection settings
                    </button>
                  </>
                )}
                <button type="button" onClick={() => setShowCreateSecret(true)} className="btn btn-primary">
                  <span className="material-symbols-outlined" aria-hidden="true">add</span>
                  New Secret
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 md:p-6">
              {secretsQuery.isLoading ? (
                <LoadingState label="Loading secrets…" />
              ) : secretsQuery.isError ? (
                <ErrorState message="Could not load the secrets in this vault." onRetry={() => void secretsQuery.refetch()} />
              ) : secrets.length === 0 ? (
                <EmptyState
                  icon="key_off"
                  title="No secrets in this vault"
                  description={selectedVault.type === 'hashicorp'
                    ? <><EmptyStateLink onClick={() => setShowCreateSecret(true)}>Add a secret</EmptyStateLink> to point at a path in HashiCorp Vault that monitors can reference.</>
                    : <><EmptyStateLink onClick={() => setShowCreateSecret(true)}>Add a secret</EmptyStateLink> to store credentials, tokens or JSON configuration that monitors can reference.</>}
                />
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
          <div className="flex-1 flex flex-col items-center justify-center gap-3 py-16" style={{ color: 'var(--m3-secondary)' }}>
            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '56px', opacity: 0.3 }}>shield_lock</span>
            <p className="text-sm">Select a vault to view its secrets</p>
          </div>
        )}
      </main>

      {/* ── Modals ── */}
      {showCreateVault && (
        <CreateVaultModal
          onClose={() => setShowCreateVault(false)}
          onCreated={(v) => { qc.invalidateQueries({ queryKey: ['vaults'] }); setSelectedVaultId(v.id); setShowCreateVault(false); toast.success(`Created vault "${v.name}".`) }}
        />
      )}
      {showCreateSecret && selectedVaultId !== null && (
        <CreateSecretModal
          vaultId={selectedVaultId}
          vaultType={selectedVault?.type ?? 'local'}
          onClose={() => setShowCreateSecret(false)}
          onCreated={() => { qc.invalidateQueries({ queryKey: ['vault-secrets', selectedVaultId] }); setShowCreateSecret(false); toast.success('Secret saved.') }}
        />
      )}
      {showConnection && selectedVault?.type === 'hashicorp' && (
        <ConnectionSettingsModal
          vaultId={selectedVault.id}
          onClose={() => setShowConnection(false)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ['vaults'] }); setShowConnection(false); toast.success('Connection settings saved.') }}
        />
      )}
      {revealedSecret && (
        <RevealModal secret={revealedSecret} onClose={() => setRevealedSecret(null)} />
      )}
      {deleteVaultTarget && (
        <DeleteVaultModal
          vault={deleteVaultTarget}
          secretCount={deleteVaultTarget.id === selectedVaultId && secretsQuery.data ? secrets.length : null}
          pending={deleteVault.isPending}
          onClose={() => setDeleteVaultTarget(null)}
          onConfirm={() => deleteVault.mutate(deleteVaultTarget.id)}
        />
      )}
      {deleteSecretTarget && (
        <ConfirmModal
          title="Delete secret"
          message={`Delete secret "${deleteSecretTarget.name}"? This action cannot be undone.`}
          confirmLabel="Delete"
          pending={deleteSecret.isPending}
          pendingLabel="Deleting…"
          onConfirm={() => deleteSecret.mutate({ vaultId: deleteSecretTarget.vaultId, secretId: deleteSecretTarget.id })}
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
      className={`group flex items-center gap-1 rounded-xl transition-colors ${isSelected ? '' : 'hover:bg-[var(--m3-surface-container)]'}`}
      style={{
        background: isSelected ? 'var(--m3-surface-container-lowest)' : undefined,
        boxShadow: isSelected ? '0 1px 4px rgba(19,27,46,0.08)' : 'none',
      }}
    >
      <button
        type="button"
        onClick={onClick}
        aria-current={isSelected ? 'true' : undefined}
        className="flex-1 min-w-0 flex items-center gap-3 px-3 py-2.5 rounded-xl text-left focus-ring"
      >
        <span className="material-symbols-outlined shrink-0" aria-hidden="true" style={{ fontSize: '18px', color: isSelected ? 'var(--m3-primary)' : 'var(--m3-secondary)', fontVariationSettings: isSelected ? "'FILL' 1" : "'FILL' 0" }}>{VAULT_TYPE_ICONS[vault.type]}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium truncate" style={{ color: 'var(--m3-on-surface)' }}>{vault.name}</span>
          {vault.description && (
            <span className="block text-[10px] truncate" style={{ color: 'var(--m3-secondary)' }}>{vault.description}</span>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete vault ${vault.name}`}
        title="Delete vault"
        className="btn-icon w-7 h-7 mr-1.5 shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 hover:!text-[color:var(--m3-down)]"
      >
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px' }}>close</span>
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
      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 rounded-xl"
      style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}
    >
      <span className="material-symbols-outlined shrink-0" aria-hidden="true" style={{ fontSize: '20px', color: 'var(--m3-secondary)' }}>{TYPE_ICONS[secret.type] ?? 'key'}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold break-all" style={{ color: 'var(--m3-on-surface)' }}>{secret.name}</p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--m3-secondary)' }}>
          {TYPE_LABELS[secret.type]} · Updated {formatDate(secret.updatedAt)}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button type="button" onClick={onReveal} disabled={isRevealing} className="btn btn-secondary btn-sm">
          <span className={`material-symbols-outlined ${isRevealing ? 'animate-spin' : ''}`} aria-hidden="true">{isRevealing ? 'progress_activity' : 'visibility'}</span>
          {isRevealing ? 'Loading…' : 'Reveal'}
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete secret ${secret.name}`}
          title="Delete secret"
          className="btn-icon hover:!text-[color:var(--m3-down)]"
        >
          <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px' }}>delete</span>
        </button>
      </div>
    </div>
  )
}

// ── Delete Vault modal (with checkbox when secrets exist) ─────────────────────

function DeleteVaultModal({ vault, secretCount, pending, onClose, onConfirm }: {
  vault: Vault
  secretCount: number | null  // null = unknown (vault not currently selected/loaded)
  pending: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const hasSecrets = secretCount === null || secretCount > 0
  const [confirmed, setConfirmed] = useState(false)

  return (
    <ModalShell onClose={pending ? undefined : onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Delete vault"
        aria-busy={pending || undefined}
        className="rounded-2xl p-6 w-full max-w-sm space-y-4"
        style={{ background: 'var(--m3-surface-container-lowest)', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
      >
        <div className="flex items-start gap-3">
          <span className="material-symbols-outlined mt-0.5 shrink-0" aria-hidden="true" style={{ fontSize: '22px', color: 'var(--m3-error)' }}>warning</span>
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
              {vault.type === 'hashicorp' && ' Only the references are deleted; nothing is removed from HashiCorp Vault.'}
            </p>
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={pending}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm font-medium" style={{ color: 'var(--m3-on-error-container)' }}>
                I understand all secrets will be permanently deleted
              </span>
            </label>
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={pending} className="btn btn-secondary rounded-full px-5 py-2">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending || (hasSecrets && !confirmed)}
            className="btn btn-danger rounded-full px-5 py-2"
          >
            {pending ? 'Deleting…' : 'Delete vault'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

// ── Create Vault modal ─────────────────────────────────────────────────────────

function CreateVaultModal({ onClose, onCreated }: { onClose: () => void; onCreated: (v: Vault) => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<Vault['type']>('local')
  const [connection, setConnection] = useState<ConnectionForm>(EMPTY_CONNECTION)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const typeLabelId = useId()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const vault = await api.post<Vault>('/admin/vaults', {
        name,
        description: description || undefined,
        ...(type === 'hashicorp' ? { type, connection } : {}),
      })
      onCreated(vault)
    } catch (err) {
      setError(errorMessage(err, 'Failed to create vault'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal title="Create Vault" icon="shield_lock" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <Field label="Vault name" required>
          <input value={name} onChange={(e) => setName(e.target.value)} required className="input-sig" placeholder="My Credentials" autoFocus />
        </Field>
        <Field label="Description (optional)">
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="input-sig" placeholder="What this vault stores…" />
        </Field>
        <div role="group" aria-labelledby={typeLabelId}>
          <p id={typeLabelId} className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Type</p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              aria-pressed={type === 'local'}
              onClick={() => setType('local')}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg flex-1 focus-ring ${type === 'local' ? 'selection-active' : ''}`}
              style={{ border: '1px solid var(--m3-outline-variant)' }}
            >
              <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px' }}>storage</span>
              <span className="text-sm font-medium">Local</span>
            </button>
            <button
              type="button"
              aria-pressed={type === 'hashicorp'}
              onClick={() => setType('hashicorp')}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg flex-1 focus-ring ${type === 'hashicorp' ? 'selection-active' : ''}`}
              style={{ border: '1px solid var(--m3-outline-variant)' }}
            >
              <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px' }}>vpn_key</span>
              <span className="text-sm font-medium">HashiCorp Vault</span>
            </button>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg flex-1 opacity-40 cursor-not-allowed" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }} title="Coming soon">
              <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px', color: 'var(--m3-secondary)' }}>cloud</span>
              <div>
                <span className="text-sm" style={{ color: 'var(--m3-secondary)' }}>Azure Key Vault</span>
                <span className="text-[10px] block" style={{ color: 'var(--m3-secondary)' }}>Coming soon</span>
              </div>
            </div>
          </div>
        </div>
        {type === 'hashicorp' && <ConnectionFields value={connection} onChange={setConnection} />}
        <ModalActions onClose={onClose} loading={loading} submitLabel="Create Vault" />
      </form>
    </Modal>
  )
}

// ── Create Secret modal ────────────────────────────────────────────────────────

function CreateSecretModal({ vaultId, vaultType, onClose, onCreated }: { vaultId: number; vaultType: Vault['type']; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const isReference = vaultType === 'hashicorp'
  const [type, setType] = useState<'userpass' | 'value' | 'json'>('userpass')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [value, setValue] = useState('')
  const [json, setJson] = useState('')
  const [jsonError, setJsonError] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const typeLabelId = useId()

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
      if (isReference) {
        body['path'] = path
        if (type === 'value') body['key'] = secretKey
      } else {
        if (type === 'userpass') body['userpass'] = { username, password }
        if (type === 'value') body['value'] = value
        if (type === 'json') body['json'] = json
      }
      await api.post(`/admin/vaults/${vaultId}/secrets`, body)
      onCreated()
    } catch (err) {
      setError(errorMessage(err, 'Failed to create secret'))
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
    <Modal title="New Secret" icon="key" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <Field label="Secret name" required>
          <input value={name} onChange={(e) => setName(e.target.value)} required className="input-sig" placeholder="my-api-key" autoFocus />
        </Field>

        <div role="group" aria-labelledby={typeLabelId}>
          <p id={typeLabelId} className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Type</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {types.map((t) => (
              <button
                key={t.value}
                type="button"
                aria-pressed={type === t.value}
                onClick={() => setType(t.value)}
                className={`px-3 py-2.5 rounded-xl text-left transition-all focus-ring ${type === t.value ? 'selection-active' : ''}`}
                style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)', border: '1px solid var(--m3-outline-variant)' }}
              >
                <span className="block text-xs font-bold">{t.label}</span>
                <span className="block text-[10px] mt-0.5 opacity-80">{t.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {isReference && (
          <>
            <Field label="Path" required hint={type === 'userpass' ? 'Reads the keys "username" and "password" at this path.' : type === 'json' ? 'Reads every key at this path.' : 'Path of the KV v2 secret, relative to the mount.'}>
              <input value={path} onChange={(e) => setPath(e.target.value)} required className="input-sig font-mono" placeholder="bsp/database" autoComplete="off" />
            </Field>
            {type === 'value' && (
              <Field label="Key" required>
                <input value={secretKey} onChange={(e) => setSecretKey(e.target.value)} required className="input-sig font-mono" placeholder="api_key" autoComplete="off" />
              </Field>
            )}
          </>
        )}
        {!isReference && type === 'userpass' && (
          <>
            <Field label="Username" required>
              <input value={username} onChange={(e) => setUsername(e.target.value)} required className="input-sig" placeholder="admin" autoComplete="off" />
            </Field>
            <Field label="Password" required>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className="input-sig" placeholder="••••••••" autoComplete="new-password" />
            </Field>
          </>
        )}
        {!isReference && type === 'value' && (
          <Field label="Value" required>
            <input value={value} onChange={(e) => setValue(e.target.value)} required className="input-sig" placeholder="Bearer eyJ…" autoComplete="off" />
          </Field>
        )}
        {!isReference && type === 'json' && (
          <Field label="JSON" required error={jsonError || undefined}>
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

// ── HashiCorp connection ───────────────────────────────────────────────────────

function ConnectionFields({ value, onChange, keepHint }: { value: ConnectionForm; onChange: (v: ConnectionForm) => void; keepHint?: boolean }) {
  const set = (patch: Partial<ConnectionForm>) => onChange({ ...value, ...patch })
  const authLabelId = useId()
  const credentialHint = keepHint ? 'Leave blank to keep the saved value. Re-enter it when you change the address, namespace, mount, CA certificate or auth method.' : undefined
  const insecure = value.address.trim().toLowerCase().startsWith('http://')
  return (
    <fieldset className="space-y-3 rounded-xl p-3" style={{ border: '1px solid var(--m3-outline-variant)' }}>
      <legend className="px-1 font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Connection</legend>
      <Field label="Address" required>
        <input type="url" value={value.address} onChange={(e) => set({ address: e.target.value })} required className="input-sig font-mono" placeholder="https://vault.example.com:8200" autoComplete="off" />
      </Field>
      {insecure && <Alert tone="warning">The token is sent unencrypted over http://. Use https:// unless Vault is on a trusted private network.</Alert>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Namespace (optional)">
          <input value={value.namespace} onChange={(e) => set({ namespace: e.target.value })} className="input-sig font-mono" placeholder="team-a" autoComplete="off" />
        </Field>
        <Field label="KV v2 mount" required>
          <input value={value.mount} onChange={(e) => set({ mount: e.target.value })} required className="input-sig font-mono" placeholder="secret" autoComplete="off" />
        </Field>
      </div>
      <div role="group" aria-labelledby={authLabelId}>
        <p id={authLabelId} className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Auth method</p>
        <div className="flex gap-2">
          {(['token', 'approle'] as const).map((method) => (
            <button
              key={method}
              type="button"
              aria-pressed={value.authMethod === method}
              onClick={() => set({ authMethod: method })}
              className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium focus-ring ${value.authMethod === method ? 'selection-active' : ''}`}
              style={{ border: '1px solid var(--m3-outline-variant)' }}
            >
              {method === 'token' ? 'Token' : 'AppRole'}
            </button>
          ))}
        </div>
      </div>
      {value.authMethod === 'token' ? (
        <Field label="Token" required={!keepHint} hint={credentialHint}>
          <input type="password" value={value.token} onChange={(e) => set({ token: e.target.value })} required={!keepHint} className="input-sig font-mono" autoComplete="new-password" />
        </Field>
      ) : (
        <>
          <Field label="Role ID" required>
            <input value={value.roleId} onChange={(e) => set({ roleId: e.target.value })} required className="input-sig font-mono" autoComplete="off" />
          </Field>
          <Field label="Secret ID" required={!keepHint} hint={credentialHint}>
            <input type="password" value={value.secretId} onChange={(e) => set({ secretId: e.target.value })} required={!keepHint} className="input-sig font-mono" autoComplete="new-password" />
          </Field>
          <Field label="AppRole mount">
            <input value={value.approleMount} onChange={(e) => set({ approleMount: e.target.value })} className="input-sig font-mono" placeholder="approle" autoComplete="off" />
          </Field>
        </>
      )}
      <Field label="CA certificate (optional)" hint="PEM. Only for a private CA; include the full chain.">
        <textarea value={value.caCert} onChange={(e) => set({ caCert: e.target.value })} rows={3} className="input-sig font-mono text-xs resize-none" placeholder="-----BEGIN CERTIFICATE-----" />
      </Field>
    </fieldset>
  )
}

function ConnectionSettingsModal({ vaultId, onClose, onSaved }: { vaultId: number; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<ConnectionForm | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const query = useQuery<{ connection: HashicorpConnection }>({
    queryKey: ['vault-connection', vaultId],
    queryFn: () => api.get(`/admin/vaults/${vaultId}`),
    gcTime: 0,
  })

  const current = form ?? (query.data ? { ...EMPTY_CONNECTION, ...query.data.connection, token: '', secretId: '' } : null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!current) return
    setError('')
    setLoading(true)
    try {
      await api.patch(`/admin/vaults/${vaultId}`, { connection: current })
      onSaved()
    } catch (err) {
      setError(errorMessage(err, 'Failed to save connection settings'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal title="Connection settings" icon="settings" onClose={onClose}>
      {query.isError ? (
        <ErrorState message="Could not load the connection settings." onRetry={() => void query.refetch()} />
      ) : !current ? (
        <LoadingState label="Loading…" />
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <Alert tone="error">{error}</Alert>}
          <ConnectionFields value={current} onChange={setForm} keepHint />
          <ModalActions onClose={onClose} loading={loading} submitLabel="Save" />
        </form>
      )}
    </Modal>
  )
}

// ── Reveal modal ───────────────────────────────────────────────────────────────

/** Pretty-prints stored JSON; falls back to the raw text when it cannot be parsed so the modal never crashes. */
function formatJson(raw: string): { text: string; valid: boolean } {
  try {
    return { text: JSON.stringify(JSON.parse(raw), null, 2), valid: true }
  } catch {
    return { text: raw, valid: false }
  }
}

function RevealModal({ secret, onClose }: { secret: RevealedSecret; onClose: () => void }) {
  const [showPassword, setShowPassword] = useState(false)
  const json = secret.type === 'json' ? formatJson(secret.value.value ?? '{}') : null

  return (
    <Modal title={secret.name} icon={TYPE_ICONS[secret.type] ?? 'key'} onClose={onClose}>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full" style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-secondary)' }}>
            {TYPE_LABELS[secret.type]}
          </span>
        </div>

        {secret.source && (
          <p className="text-xs font-mono break-all" style={{ color: 'var(--m3-secondary)' }}>
            Source: {secret.source.path}{secret.source.key ? ` (${secret.source.key})` : ''}
          </p>
        )}

        {secret.type === 'userpass' && (
          <>
            <RevealField label="Username" value={secret.value.username ?? ''} mono />
            <RevealField label="Password" value={secret.value.password ?? ''} hidden={!showPassword} mono
              action={
                <button type="button" onClick={() => setShowPassword((p) => !p)} aria-pressed={showPassword} className="btn btn-ghost btn-sm py-1 text-xs">
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              }
            />
          </>
        )}
        {(secret.type === 'value') && (
          <RevealField label="Value" value={secret.value.value ?? ''} mono />
        )}
        {json && (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>JSON</p>
              <CopyButton value={json.text} iconOnly />
            </div>
            {!json.valid && (
              <Alert tone="warning" className="mb-2">The stored value is not valid JSON; showing it as plain text.</Alert>
            )}
            <pre className="text-xs p-3 rounded-xl overflow-auto max-h-64" style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-on-surface)', fontFamily: 'monospace' }}>
              {json.text}
            </pre>
          </div>
        )}

        <div className="pt-2 flex justify-end">
          <button type="button" onClick={onClose} className="btn btn-secondary">
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
        {!hidden && <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} iconOnly />}
      </div>
    </div>
  )
}

// ── Shared primitives ──────────────────────────────────────────────────────────

function ModalActions({ onClose, loading, submitLabel }: { onClose: () => void; loading: boolean; submitLabel: string }) {
  return (
    <div className="flex flex-wrap justify-end gap-3 pt-2">
      <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
      <button type="submit" disabled={loading} className="btn btn-primary">
        {loading ? 'Saving…' : submitLabel}
      </button>
    </div>
  )
}
