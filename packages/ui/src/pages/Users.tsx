import { useId, useState, type ComponentProps, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, getCurrentUser } from '../api/client'
import { ConfirmIdentityModal } from '../components/ConfirmIdentityModal'
import { ConfirmModal } from '../components/ConfirmModal'
import { CopyButton } from '../components/CopyButton'
import { ResetTwoFactorModal } from '../components/ResetTwoFactorModal'
import { SingleSignOnModal } from '../components/SingleSignOnModal'
import { useSsoConfirmation } from '../components/SsoConfirmation'
import { Alert, EmptyStateLink, EmptyTableRow, ErrorState, LoadingState, PageContainer, PageHeader, useToast, DataTable, DataTh, useTableSort } from '../components/ui'
import { formatDate } from '../lib/dateFormat'

interface User {
  id: number
  email: string
  role: string
  pendingTemporaryPassword: boolean
  ssoLinked: boolean
  twoFactorEnabled: number
  createdAt: number
}

export interface UserRole { value: string; label: string; desc: string }

/** A button in the header of the page that opens a dialog of the application's own (say, access settings). */
export interface UsersPageAction { label: string; icon: string; dialog: (close: () => void) => ReactNode }

export interface UsersPageProps {
  roles: readonly UserRole[]
  /** Higher number = more access; moving a user to a lower rank is a demotion and needs confirmation. */
  roleRank: Readonly<Record<string, number>>
  /** The role a new user starts with. */
  defaultRole: string
  actions?: readonly UsersPageAction[]
}

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback
}

const ROW_ACTION = 'w-8 h-8 flex items-center justify-center rounded-lg transition-colors text-xs focus-ring'

export default function UsersPage({ roles: ROLES, roleRank: ROLE_RANK, defaultRole, actions = [] }: UsersPageProps) {
  const roleLabel = (role: string) => ROLES.find((r) => r.value === role)?.label ?? role
  const qc = useQueryClient()
  const ssoConfirmation = useSsoConfirmation()
  const toast = useToast()
  const emailInputId = useId()
  const [showCreate, setShowCreate] = useState(false)
  const [showSso, setShowSso] = useState(false)
  const [openAction, setOpenAction] = useState<number | null>(null)
  const [newEmail, setNewEmail] = useState('')
  const [newRole, setNewRole] = useState(defaultRole)
  const [createdUser, setCreatedUser] = useState<{ email: string; temporaryPassword: string } | null>(null)
  const [resetResult, setResetResult] = useState<{ email: string; temporaryPassword: string } | null>(null)
  const [identityPrompt, setIdentityPrompt] = useState<Omit<ComponentProps<typeof ConfirmIdentityModal>, 'onClose'> | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null)
  const [twoFactorResetTarget, setTwoFactorResetTarget] = useState<User | null>(null)
  const [message, setMessage] = useState('')

  const { data: users = [], isLoading, isError, refetch } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: () => api.get('/admin/users'),
  })
  const { rows: sortedUsers, sort } = useTableSort(users, {
    email: (u) => u.email,
    role: (u) => ROLE_RANK[u.role] ?? 0,
    status: (u) => u.pendingTemporaryPassword,
    created: (u) => u.createdAt,
  })

  function confirmCreateUser() {
    const email = newEmail
    setIdentityPrompt({
      title: 'Create user',
      message: `Create ${email} as ${roleLabel(newRole)}? They will be able to sign in with a temporary password.`,
      confirmLabel: 'Create user',
      pendingLabel: 'Creating…',
      action: async (currentPassword) => {
        const created = await api.post<{ email: string; temporaryPassword: string }>('/admin/users', { email, role: newRole, currentPassword })
        qc.invalidateQueries({ queryKey: ['users'] })
        setCreatedUser(created)
        setShowCreate(false)
        setNewEmail('')
      },
    })
  }

  function confirmResetPassword(user: User) {
    setIdentityPrompt({
      title: 'Reset password',
      message: `Reset password for ${user.email}? Their current password will stop working.`,
      confirmLabel: 'Reset password',
      pendingLabel: 'Resetting…',
      danger: true,
      action: async (currentPassword) => {
        const reset = await api.post<{ temporaryPassword: string }>(`/admin/users/${user.id}/reset-password`, { currentPassword })
        setResetResult({ email: user.email, temporaryPassword: reset.temporaryPassword })
        qc.invalidateQueries({ queryKey: ['users'] })
      },
    })
  }

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
    mutationFn: ({ id, currentPassword }: { id: number; currentPassword: string | undefined }) =>
      ssoConfirmation.run(() => api.post<{ twoFactorEnabled: false }>(`/admin/users/${id}/reset-2fa`, currentPassword === undefined ? {} : { currentPassword })),
    onSuccess: (_data, variables) => {
      const user = users.find((candidate) => candidate.id === variables.id)
      setMessage(user ? `Two-factor authentication reset for ${user.email}.` : 'Two-factor authentication reset.')
      setTwoFactorResetTarget(null)
      qc.invalidateQueries({ queryKey: ['users'] })
    },
  })

  function changeRole(user: User, role: string) {
    if (user.role === role) return
    const demotion = (ROLE_RANK[role] ?? 0) < (ROLE_RANK[user.role] ?? 0)
    setIdentityPrompt({
      title: 'Change role',
      message: `Change ${user.email} from ${roleLabel(user.role)} to ${roleLabel(role)}?${demotion ? ' They will lose access to some areas immediately.' : ''}`,
      confirmLabel: `Make ${roleLabel(role)}`,
      pendingLabel: 'Saving…',
      danger: demotion,
      action: async (currentPassword) => {
        await api.patch(`/admin/users/${user.id}/role`, { role, currentPassword })
        toast.success(`${user.email} is now ${roleLabel(role)}.`)
        qc.invalidateQueries({ queryKey: ['users'] })
      },
    })
  }

  const currentUser = getCurrentUser()

  return (
    <PageContainer>
      <PageHeader
        title="Users"
        subtitle={isLoading || isError ? undefined : `${users.length} user${users.length !== 1 ? 's' : ''}`}
        actions={
          <>
            {actions.map((action, index) => (
              <button key={action.label} type="button" onClick={() => setOpenAction(index)} className="btn btn-secondary">
                <span className="material-symbols-outlined" aria-hidden="true">{action.icon}</span>
                {action.label}
              </button>
            ))}
            <button type="button" onClick={() => setShowSso(true)} className="btn btn-secondary">
              <span className="material-symbols-outlined" aria-hidden="true">passkey</span>
              Single sign-on
            </button>
            <button type="button" onClick={() => setShowCreate(true)} className="btn btn-primary">
              <span className="material-symbols-outlined" aria-hidden="true">person_add</span>
              New User
            </button>
          </>
        }
      />

      {showSso && <SingleSignOnModal onClose={() => setShowSso(false)} />}
      {openAction !== null && actions[openAction]?.dialog(() => setOpenAction(null))}

      {message && (
        <Alert tone="success" onDismiss={() => setMessage('')} className="max-w-2xl">{message}</Alert>
      )}

      {/* Create user form */}
      {showCreate && (
        <div className="rounded-2xl p-5" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          <p className="font-headline font-semibold text-sm mb-3" style={{ color: 'var(--m3-on-surface)' }}>New User</p>
          <label htmlFor={emailInputId} className="block text-xs mb-1.5" style={{ color: 'var(--m3-secondary)' }}>Email</label>
          <div className="flex flex-wrap gap-3">
            <input
              id={emailInputId}
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="user@example.com"
              className="input-sig flex-1 min-w-[200px]"
              onKeyDown={(e) => e.key === 'Enter' && newEmail && confirmCreateUser()}
            />
            <select aria-label="Role" value={newRole} onChange={(e) => setNewRole(e.target.value)} className="input-sig w-auto">
              {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            <button
              type="button"
              onClick={() => newEmail && confirmCreateUser()}
              disabled={!newEmail}
              className="btn btn-primary"
            >
              Create
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
          <DataTable sort={sort} className="w-full min-w-[720px] text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
                {['Email', 'Role', 'Status', 'Created', ''].map((h) => (
                  <DataTh
                    key={h}
                    resizable={h !== ''}
                    {...(h !== '' && { sortKey: h.toLowerCase() })}
                    className={`px-4 py-3 font-mono text-xs uppercase tracking-wider ${h === '' ? 'text-right' : 'text-left'}`}
                    style={{ color: 'var(--m3-secondary)', background: 'var(--m3-surface-container)' }}
                  >
                    {h === '' ? <span className="sr-only">Actions</span> : h}
                  </DataTh>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedUsers.map((user, i) => (
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
                      {user.pendingTemporaryPassword ? (
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
                      {user.ssoLinked && (
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full" title="Signed in through single sign-on; matched by their identity-provider account" style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-on-surface)' }}>SSO</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--m3-secondary)' }}>
                    {formatDate(user.createdAt)}
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
                        onClick={() => confirmResetPassword(user)}
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
                  description={<><EmptyStateLink onClick={() => setShowCreate(true)}>Add a user</EmptyStateLink> to share access to the admin panel.</>}
                />
              )}
            </tbody>
          </DataTable>
        </div>
      )}
      {identityPrompt && <ConfirmIdentityModal {...identityPrompt} onClose={() => setIdentityPrompt(null)} />}
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
          ssoConfirmation={ssoConfirmation}
          onConfirm={(currentPassword) => resetTwoFactorMutation.mutate({ id: twoFactorResetTarget.id, currentPassword })}
          onCancel={() => { if (!resetTwoFactorMutation.isPending) setTwoFactorResetTarget(null) }}
        />
      )}
    </PageContainer>
  )
}
