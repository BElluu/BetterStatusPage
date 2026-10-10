import { useId, useState } from 'react'
import { TOKEN_PRESETS, TOKEN_RESOURCES, VAULT_USE_SCOPE } from '@bsp/shared'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { ConfirmModal } from '../components/ConfirmModal'
import { ModalShell } from '../components/ModalShell'
import { CopyButton } from '../components/CopyButton'
import { Alert, EmptyStateLink, EmptyTableRow, ErrorState, LoadingState, PageContainer, PageHeader, useToast } from '../components/ui'
import { formatDate } from '../lib/dateFormat'

interface ApiToken {
  id: number
  name: string
  prefix: string
  scopes: string[]
  createdBy: string
  createdAt: number
  expiresAt: number | null
  lastUsedAt: number | null
}

/** Ninety days unless a person decides otherwise: a forgotten token should not work forever. */
const DEFAULT_EXPIRY = '90'
const EXPIRIES = [
  { value: '30',  label: '30 days' },
  { value: '90',  label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never expires' },
]

const read = (key: string) => `${key}:read`
const write = (key: string) => `${key}:write`

/** What a token may do, for the list: each part with its highest level, the vault permission last. */
function permissionLabels(scopes: string[]): string[] {
  const labels = TOKEN_RESOURCES.flatMap((resource) => {
    if (scopes.includes(write(resource.key))) return [`${resource.label} · write`]
    if (scopes.includes(read(resource.key))) return [`${resource.label} · read`]
    return []
  })
  return scopes.includes(VAULT_USE_SCOPE) ? [...labels, 'Vault secrets'] : labels
}

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback
}

function expiry(token: ApiToken) {
  if (token.expiresAt === null) return 'Never'
  return token.expiresAt <= Date.now() ? `Expired ${formatDate(token.expiresAt)}` : formatDate(token.expiresAt)
}

export default function ApiTokensPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const nameInputId = useId()
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>([])
  const [expiresInDays, setExpiresInDays] = useState(DEFAULT_EXPIRY)
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<ApiToken | null>(null)
  const [error, setError] = useState('')

  const { data: tokens = [], isLoading, isError, refetch } = useQuery<ApiToken[]>({
    queryKey: ['api-tokens'],
    queryFn: () => api.get('/admin/api-tokens'),
  })

  const createMutation = useMutation({
    mutationFn: () => api.post<ApiToken & { token: string }>('/admin/api-tokens', {
      name,
      scopes,
      expiresInDays: expiresInDays === 'never' ? null : Number(expiresInDays),
    }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['api-tokens'] })
      setCreated({ name: data.name, token: data.token })
      setShowCreate(false)
      setName('')
      setScopes([])
      setExpiresInDays(DEFAULT_EXPIRY)
      setError('')
    },
    onError: (err) => setError(errorMessage(err, 'Failed to create token')),
  })

  const revokeMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/api-tokens/${id}`),
    onSuccess: () => {
      toast.success(revokeTarget ? `Revoked ${revokeTarget.name}.` : 'Token revoked.')
      setRevokeTarget(null)
      qc.invalidateQueries({ queryKey: ['api-tokens'] })
    },
    onError: (err) => {
      setRevokeTarget(null)
      toast.error(errorMessage(err, 'Failed to revoke token'))
    },
  })

  function openCreate() {
    setShowCreate(true)
    setCreated(null)
    setError('')
  }

  /** Writing a part includes reading it, so ticking Write ticks Read and unticking Read unticks Write. */
  function toggle(scope: string, on: boolean) {
    setScopes((current) => {
      const next = new Set(current)
      const [key, level] = scope.split(':') as [string, string]
      if (on) {
        next.add(scope)
        if (level === 'write') next.add(read(key))
      } else {
        next.delete(scope)
        if (level === 'read') next.delete(write(key))
      }
      return [...next]
    })
  }

  const canCreate = name.trim().length > 0 && scopes.length > 0 && !createMutation.isPending

  return (
    <PageContainer>
      <PageHeader
        title="API tokens"
        subtitle={isLoading || isError ? undefined : `${tokens.length} token${tokens.length !== 1 ? 's' : ''}`}
        actions={
          <button type="button" onClick={openCreate} className="btn btn-primary">
            <span className="material-symbols-outlined" aria-hidden="true">add</span>
            New token
          </button>
        }
      />

      <p className="text-sm max-w-2xl" style={{ color: 'var(--m3-secondary)' }}>
        Tokens let scripts and CI call the admin API with <code className="font-mono">Authorization: Bearer &lt;token&gt;</code>.
        A token has only the permissions you tick. It cannot manage users, single sign-on, status page access, vaults, backups or other tokens, and is deleted when the administrator who created it is removed or loses the Admin role.
      </p>

      {showCreate && (
        <ModalShell align="top" onClose={() => setShowCreate(false)} label="New token">
        <form
          className="rounded-2xl p-6 w-full max-w-2xl"
          style={{ background: 'var(--m3-surface-container-lowest)', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
          onSubmit={(e) => { e.preventDefault(); if (canCreate) createMutation.mutate() }}
        >
          <p className="font-headline font-semibold text-sm mb-3" style={{ color: 'var(--m3-on-surface)' }}>New token</p>
          {error && <Alert tone="error" className="mb-3">{error}</Alert>}
          <label htmlFor={nameInputId} className="block text-xs mb-1.5" style={{ color: 'var(--m3-secondary)' }}>Name</label>
          <div className="flex flex-wrap gap-3">
            <input
              id={nameInputId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="GitHub Actions"
              className="input-sig flex-1 min-w-[200px]"
            />
            <select aria-label="Expires" value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)} className="input-sig w-auto">
              {EXPIRIES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
            </select>
          </div>

          <fieldset className="mt-4">
            <legend className="text-xs mb-1.5" style={{ color: 'var(--m3-secondary)' }}>Permissions</legend>
            <div className="flex flex-wrap gap-2 mb-3">
              {TOKEN_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  title={preset.description}
                  onClick={() => setScopes([...preset.scopes])}
                  className="btn btn-secondary btn-sm"
                >
                  {preset.label}
                </button>
              ))}
              <button type="button" onClick={() => setScopes([])} className="btn btn-ghost btn-sm">Clear</button>
            </div>
            <div className="rounded-xl overflow-x-auto" style={{ border: '1px solid var(--m3-outline-variant)' }}>
              <table className="w-full min-w-[480px] text-sm">
                <thead>
                  <tr style={{ background: 'var(--m3-surface-container)' }}>
                    <th className="px-4 py-2 text-left font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Part</th>
                    <th className="px-4 py-2 w-20 font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Read</th>
                    <th className="px-4 py-2 w-20 font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Write</th>
                  </tr>
                </thead>
                <tbody>
                  {TOKEN_RESOURCES.map((resource, index) => (
                    <tr key={resource.key} style={{ borderTop: index > 0 ? '1px solid var(--m3-outline-variant)' : 'none' }}>
                      <td className="px-4 py-2">
                        <span style={{ color: 'var(--m3-on-surface)' }}>{resource.label}</span>
                        <span className="block text-xs" style={{ color: 'var(--m3-secondary)' }}>{resource.description}</span>
                      </td>
                      {(['read', 'write'] as const).map((level) => (
                        <td key={level} className="px-4 py-2 text-center">
                          {resource.levels.includes(level) && (
                            <input
                              type="checkbox"
                              aria-label={`${resource.label} ${level}`}
                              checked={scopes.includes(`${resource.key}:${level}`)}
                              onChange={(e) => toggle(`${resource.key}:${level}`, e.target.checked)}
                            />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label className="flex items-start gap-3 mt-3 text-sm" style={{ color: 'var(--m3-on-surface)' }}>
              <input
                type="checkbox"
                className="mt-1"
                checked={scopes.includes(VAULT_USE_SCOPE)}
                onChange={(e) => toggle(VAULT_USE_SCOPE, e.target.checked)}
              />
              <span>
                Use vault secrets
                <span className="block text-xs" style={{ color: 'var(--m3-secondary)' }}>
                  Lets the token attach a vault secret to a monitor or channel, or change one that already uses a vault. Without it the token cannot read or use credentials from a vault.
                </span>
              </span>
            </label>
          </fieldset>

          <div className="flex flex-wrap gap-3 mt-4">
            <button type="submit" disabled={!canCreate} className="btn btn-primary">
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </button>
            <button type="button" onClick={() => setShowCreate(false)} className="btn btn-ghost">Cancel</button>
          </div>
        </form>
        </ModalShell>
      )}

      {created && (
        <Alert tone="success" title={<>Token <strong>{created.name}</strong> created</>} onDismiss={() => setCreated(null)}>
          <p className="text-xs mb-3" style={{ color: 'var(--m3-secondary)' }}>
            Copy it now. It will not be shown again; if you lose it, revoke it and create a new one.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <code
              className="font-mono text-sm px-4 py-2 rounded-xl select-all break-all"
              style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-on-surface)' }}
            >
              {created.token}
            </code>
            <CopyButton value={created.token} />
          </div>
        </Alert>
      )}

      {isLoading ? (
        <LoadingState label="Loading tokens…" />
      ) : isError ? (
        <ErrorState message="Could not load tokens." onRetry={() => void refetch()} />
      ) : (
        <div className="rounded-2xl overflow-x-auto" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
                {['Name', 'Token', 'Permissions', 'Created by', 'Expires', 'Last used', ''].map((h) => (
                  <th
                    key={h}
                    className={`px-4 py-3 font-mono text-xs uppercase tracking-wider ${h === '' ? 'text-right' : 'text-left'}`}
                    style={{ color: 'var(--m3-secondary)', background: 'var(--m3-surface-container)' }}
                  >
                    {h === '' ? <span className="sr-only">Actions</span> : h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tokens.map((token, i) => (
                <tr key={token.id} style={{ borderTop: i > 0 ? '1px solid var(--m3-outline-variant)' : 'none' }}>
                  <td className="px-4 py-3 font-medium" style={{ color: 'var(--m3-on-surface)' }}>{token.name}</td>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--m3-secondary)' }}>{token.prefix}…</td>
                  <td className="px-4 py-3">
                    <ul className="flex flex-wrap gap-1.5" aria-label={`Permissions of ${token.name}`}>
                      {permissionLabels(token.scopes).map((label) => (
                        <li key={label} className="text-xs font-semibold px-2 py-0.5 rounded-lg" style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-on-surface)' }}>
                          {label}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--m3-secondary)' }}>{token.createdBy}</td>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--m3-secondary)' }}>{expiry(token)}</td>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--m3-secondary)' }}>
                    {token.lastUsedAt === null ? 'Never' : formatDate(token.lastUsedAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end">
                      <button
                        type="button"
                        onClick={() => setRevokeTarget(token)}
                        title="Revoke token"
                        aria-label={`Revoke ${token.name}`}
                        className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors text-xs focus-ring"
                        style={{ color: 'var(--m3-secondary)' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--m3-error-container)'; e.currentTarget.style.color = 'var(--m3-on-error-container)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = ''; e.currentTarget.style.color = 'var(--m3-secondary)' }}
                      >
                        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px' }}>delete</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {tokens.length === 0 && (
                <EmptyTableRow
                  colSpan={7}
                  icon="key"
                  title="No API tokens yet."
                  description={<><EmptyStateLink onClick={openCreate}>Create a token</EmptyStateLink> to call the admin API from scripts and CI.</>}
                />
              )}
            </tbody>
          </table>
        </div>
      )}

      {revokeTarget && (
        <ConfirmModal
          title="Revoke token"
          message={`Revoke "${revokeTarget.name}"? Anything still using it stops working immediately.`}
          confirmLabel="Revoke"
          pending={revokeMutation.isPending}
          pendingLabel="Revoking…"
          onConfirm={() => revokeMutation.mutate(revokeTarget.id)}
          onCancel={() => setRevokeTarget(null)}
        />
      )}
    </PageContainer>
  )
}
