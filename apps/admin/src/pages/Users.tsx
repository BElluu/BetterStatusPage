import { useId, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, getCurrentUser } from '../api/client'
import { ConfirmModal } from '../components/ConfirmModal'
import { CopyButton } from '../components/CopyButton'
import { ResetTwoFactorModal } from '../components/ResetTwoFactorModal'
import { Alert, EmptyStateLink, EmptyTableRow, ErrorState, LoadingState, PageContainer, PageHeader, useToast } from '../components/ui'

interface User {
  id: number
  email: string
  role: string
  mustChangePassword: number
  twoFactorEnabled: number
  createdAt: number
}

const ROLES = [
  { value: 'admin',    label: 'Admin',    desc: 'Full access' },
  { value: 'operator', label: 'Operator', desc: 'Everything except Users' },
  { value: 'branding', label: 'Branding', desc: 'Branding & Builder' },
]

/** Higher number = more access; moving a user to a lower rank is a demotion and needs confirmation. */
const ROLE_RANK: Record<string, number> = { admin: 3, operator: 2, branding: 1 }

function roleLabel(role: string) {
  return ROLES.find((r) => r.value === role)?.label ?? role
}

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback
}

const ROW_ACTION = 'w-8 h-8 flex items-center justify-center rounded-lg transition-colors text-xs focus-ring'

export default function UsersPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const emailInputId = useId()
  const [showCreate, setShowCreate] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [createdUser, setCreatedUser] = useState<{ email: string; temporaryPassword: string } | null>(null)
  const [resetResult, setResetResult] = useState<{ email: string; temporaryPassword: string } | null>(null)
  const [resetTarget, setResetTarget] = useState<User | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null)
  const [demotion, setDemotion] = useState<{ user: User; role: string } | null>(null)
  const [twoFactorResetTarget, setTwoFactorResetTarget] = useState<User | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const { data: users = [], isLoading, isError, refetch } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: () => api.get('/admin/users'),
  })

  const createMutation = useMutation({
    mutationFn: (email: string) => api.post<{ email: string; temporaryPassword: string }>('/admin/users', { email }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['users'] })
      setCreatedUser(data)
      setShowCreate(false)
      setNewEmail('')
      setError('')
    },
    onError: (err) => setError(errorMessage(err, 'Failed to create user')),
  })

  const resetMutation = useMutation({
    mutationFn: (id: number) => api.post<{ temporaryPassword: string }>(`/admin/users/${id}/reset-password`, {}),
    onSuccess: (data, id) => {
      const user = users.find((u) => u.id === id)
      if (user) setResetResult({ email: user.email, temporaryPassword: data.temporaryPassword })
      setResetTarget(null)
      qc.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (err) => {
      setResetTarget(null)
      toast.error(errorMessage(err, 'Failed to reset password'))
    },
  })

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: number; role: string }) =>
      api.patch(`/admin/users/${id}/role`, { role }),
    onSuccess: (_data, { id, role }) => {
      const user = users.find((u) => u.id === id)
      toast.success(user ? `${user.email} is now ${roleLabel(role)}.` : `Role changed to ${roleLabel(role)}.`)
      setDemotion(null)
      qc.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (err) => {
      setDemotion(null)
      toast.error(errorMessage(err, 'Failed to change role'))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/users/${id}`),
    onSuccess: (_data, id) => {
      const user = users.find((u) => u.id === id)
      toast.success(user ? `Deleted ${user.email}.` : 'User deleted.')
      setDeleteTarget(null)
      qc.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (err) => {
      setDeleteTarget(null)
      toast.error(errorMessage(err, 'Failed to delete user'))
    },
  })

  const resetTwoFactorMutation = useMutation({
    mutationFn: ({ id, currentPassword }: { id: number; currentPassword: string }) =>
      api.post<{ twoFactorEnabled: false }>(`/admin/users/${id}/reset-2fa`, { currentPassword }),
    onSuccess: (_data, variables) => {
      const user = users.find((candidate) => candidate.id === variables.id)
      setMessage(user ? `Two-factor authentication reset for ${user.email}.` : 'Two-factor authentication reset.')
      setTwoFactorResetTarget(null)
      qc.invalidateQueries({ queryKey: ['users'] })
    },
  })

  function changeRole(user: User, role: string) {
    if (user.role === role || roleMutation.isPending) return
    if ((ROLE_RANK[role] ?? 0) < (ROLE_RANK[user.role] ?? 0)) {
      setDemotion({ user, role })
      return
    }
    roleMutation.mutate({ id: user.id, role })
  }

  const currentUser = getCurrentUser()

  return (
    <PageContainer>
      <PageHeader
        title="Users"
        subtitle={isLoading || isError ? undefined : `${users.length} user${users.length !== 1 ? 's' : ''}`}
        actions={
          <button type="button" onClick={() => { setShowCreate(true); setError('') }} className="btn btn-primary">
            <span className="material-symbols-outlined" aria-hidden="true">person_add</span>
            New User
          </button>
        }
      />

      {message && (
        <Alert tone="success" onDismiss={() => setMessage('')} className="max-w-2xl">{message}</Alert>
      )}

      {/* Create user form */}
      {showCreate && (
        <div className="rounded-2xl p-5" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          <p className="font-headline font-semibold text-sm mb-3" style={{ color: 'var(--m3-on-surface)' }}>New User</p>
          {error && <Alert tone="error" className="mb-3">{error}</Alert>}
          <label htmlFor={emailInputId} className="block text-xs mb-1.5" style={{ color: 'var(--m3-secondary)' }}>Email</label>
          <div className="flex flex-wrap gap-3">
            <input
              id={emailInputId}
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="user@example.com"
              className="input-sig flex-1 min-w-[200px]"
              onKeyDown={(e) => e.key === 'Enter' && newEmail && createMutation.mutate(newEmail)}
            />
            <button
              type="button"
              onClick={() => newEmail && createMutation.mutate(newEmail)}
              disabled={!newEmail || createMutation.isPending}
              className="btn btn-primary"
            >
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </button>
            <button type="button" onClick={() => setShowCreate(false)} className="btn btn-ghost">
              Cancel
            </button>
          </div>
          <p className="text-xs mt-2" style={{ color: 'var(--m3-secondary)' }}>
            A temporary password will be generated. Share it with the user — they will be required to change it on first login.
          </p>
        </div>
      )}

      {/* Temp password display after creation */}
      {createdUser && (
        <Alert
          tone="success"
          title={<>User <strong>{createdUser.email}</strong> created</>}
          onDismiss={() => setCreatedUser(null)}
        >
          <p className="text-xs mb-3" style={{ color: 'var(--m3-secondary)' }}>
            Share this temporary password. It will not be shown again.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <code
              className="font-mono text-base px-4 py-2 rounded-xl select-all"
              style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-on-surface)', letterSpacing: '0.05em' }}
            >
              {createdUser.temporaryPassword}
            </code>
            <CopyButton value={createdUser.temporaryPassword} />
          </div>
        </Alert>
      )}

      {/* Reset password result */}
      {resetResult && (
        <Alert
          tone="info"
          title={<>Password reset for <strong>{resetResult.email}</strong></>}
          onDismiss={() => setResetResult(null)}
        >
          <p className="text-xs mb-3" style={{ color: 'var(--m3-secondary)' }}>
            New temporary password (shown once):
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <code
              className="font-mono text-base px-4 py-2 rounded-xl select-all"
              style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-on-surface)', letterSpacing: '0.05em' }}
            >
              {resetResult.temporaryPassword}
            </code>
            <CopyButton value={resetResult.temporaryPassword} />
          </div>
        </Alert>
      )}

      {/* Users table */}
      {isLoading ? (
        <LoadingState label="Loading users…" />
      ) : isError ? (
        <ErrorState message="Could not load users." onRetry={() => void refetch()} />
      ) : (
        <div className="rounded-2xl overflow-x-auto" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
                {['Email', 'Role', 'Status', 'Created', ''].map((h) => (
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
              {users.map((user, i) => (
                <tr
                  key={user.id}
                  style={{ borderTop: i > 0 ? '1px solid var(--m3-outline-variant)' : 'none' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--m3-surface-container)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                >
                  <td className="px-4 py-3 font-medium" style={{ color: 'var(--m3-on-surface)' }}>{user.email}</td>
                  <td className="px-4 py-3">
                    {currentUser?.userId === user.id ? (
                      <span className="text-xs font-semibold px-2.5 py-1 rounded-lg" style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-on-surface)' }}>
                        {roleLabel(user.role)}
                      </span>
                    ) : (
                      <div role="group" aria-label={`Role for ${user.email}`} className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--m3-outline-variant)', width: 'fit-content' }}>
                        {ROLES.map((r) => {
                          const active = user.role === r.value
                          return (
                            <button
                              key={r.value}
                              type="button"
                              title={r.desc}
                              aria-pressed={active}
                              onClick={() => changeRole(user, r.value)}
                              className={`text-xs font-medium px-3 py-1.5 transition-colors focus-ring ${active ? 'selection-active' : ''}`}
                              style={{
                                background: 'transparent',
                                color: 'var(--m3-secondary)',
                                cursor: active ? 'default' : 'pointer',
                              }}
                            >
                              {r.label}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      {user.mustChangePassword ? (
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: 'var(--m3-degraded-bg)', color: 'var(--m3-degraded)' }}>
                          Temp password
                        </span>
                      ) : (
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: 'var(--m3-up-bg)', color: 'var(--m3-up)' }}>
                          Active
                        </span>
                      )}
                      {!!user.twoFactorEnabled && (
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-on-surface)' }}>2FA</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--m3-secondary)' }}>
                    {new Date(user.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {!!user.twoFactorEnabled && currentUser?.userId !== user.id && (
                        <button
                          type="button"
                          onClick={() => { resetTwoFactorMutation.reset(); setTwoFactorResetTarget(user); setMessage('') }}
                          title="Reset 2FA"
                          aria-label={`Reset 2FA for ${user.email}`}
                          className={ROW_ACTION}
                          style={{ color: 'var(--m3-secondary)' }}
                          onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--m3-down-bg)'; event.currentTarget.style.color = 'var(--m3-down)' }}
                          onMouseLeave={(event) => { event.currentTarget.style.background = ''; event.currentTarget.style.color = 'var(--m3-secondary)' }}
                        >
                          <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px' }}>no_encryption</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setResetTarget(user)}
                        title="Reset password"
                        aria-label={`Reset password for ${user.email}`}
                        className={ROW_ACTION}
                        style={{ color: 'var(--m3-secondary)' }}
                        onMouseEnter={(e) => { (e.currentTarget).style.background = 'var(--m3-surface-container-high)'; (e.currentTarget).style.color = 'var(--m3-on-surface)' }}
                        onMouseLeave={(e) => { (e.currentTarget).style.background = ''; (e.currentTarget).style.color = 'var(--m3-secondary)' }}
                      >
                        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px' }}>lock_reset</span>
                      </button>
                      {currentUser?.userId !== user.id && (
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(user)}
                          title="Delete user"
                          aria-label={`Delete ${user.email}`}
                          className={ROW_ACTION}
                          style={{ color: 'var(--m3-secondary)' }}
                          onMouseEnter={(e) => { (e.currentTarget).style.background = 'var(--m3-error-container)'; (e.currentTarget).style.color = 'var(--m3-on-error-container)' }}
                          onMouseLeave={(e) => { (e.currentTarget).style.background = ''; (e.currentTarget).style.color = 'var(--m3-secondary)' }}
                        >
                          <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px' }}>delete</span>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <EmptyTableRow
                  colSpan={5}
                  icon="group"
                  title="No users yet."
                  description={<><EmptyStateLink onClick={() => { setShowCreate(true); setError('') }}>Add a user</EmptyStateLink> to share access to the admin panel.</>}
                />
              )}
            </tbody>
          </table>
        </div>
      )}
      {resetTarget && (
        <ConfirmModal
          title="Reset password"
          message={`Reset password for ${resetTarget.email}? Their current password will stop working.`}
          confirmLabel="Reset password"
          pending={resetMutation.isPending}
          pendingLabel="Resetting…"
          onConfirm={() => resetMutation.mutate(resetTarget.id)}
          onCancel={() => setResetTarget(null)}
        />
      )}
      {demotion && (
        <ConfirmModal
          title="Change role"
          message={`Change ${demotion.user.email} from ${roleLabel(demotion.user.role)} to ${roleLabel(demotion.role)}? They will lose access to some areas immediately.`}
          confirmLabel={`Make ${roleLabel(demotion.role)}`}
          pending={roleMutation.isPending}
          pendingLabel="Saving…"
          onConfirm={() => roleMutation.mutate({ id: demotion.user.id, role: demotion.role })}
          onCancel={() => setDemotion(null)}
        />
      )}
      {deleteTarget && (
        <ConfirmModal
          title="Delete user"
          message={`Delete user "${deleteTarget.email}"? This action cannot be undone.`}
          confirmLabel="Delete"
          pending={deleteMutation.isPending}
          pendingLabel="Deleting…"
          onConfirm={() => deleteMutation.mutate(deleteTarget.id)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {twoFactorResetTarget && (
        <ResetTwoFactorModal
          email={twoFactorResetTarget.email}
          pending={resetTwoFactorMutation.isPending}
          {...(resetTwoFactorMutation.error ? { error: errorMessage(resetTwoFactorMutation.error, 'Failed to reset two-factor authentication') } : {})}
          onConfirm={(currentPassword) => resetTwoFactorMutation.mutate({ id: twoFactorResetTarget.id, currentPassword })}
          onCancel={() => { if (!resetTwoFactorMutation.isPending) setTwoFactorResetTarget(null) }}
        />
      )}
    </PageContainer>
  )
}
