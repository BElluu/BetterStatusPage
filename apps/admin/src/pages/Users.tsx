import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, getCurrentUser } from '../api/client'
import { ConfirmModal } from '../components/ConfirmModal'

interface User {
  id: number
  email: string
  role: string
  mustChangePassword: number
  createdAt: number
}

const ROLES = [
  { value: 'admin',    label: 'Admin',    desc: 'Full access' },
  { value: 'operator', label: 'Operator', desc: 'Everything except Users' },
  { value: 'branding', label: 'Branding', desc: 'Branding & Builder' },
]

export default function UsersPage() {
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [createdUser, setCreatedUser] = useState<{ email: string; temporaryPassword: string } | null>(null)
  const [resetResult, setResetResult] = useState<{ email: string; temporaryPassword: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null)
  const [error, setError] = useState('')

  const { data: users = [] } = useQuery<User[]>({
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
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to create user'),
  })

  const resetMutation = useMutation({
    mutationFn: (id: number) => api.post<{ temporaryPassword: string }>(`/admin/users/${id}/reset-password`, {}),
    onSuccess: (data, id) => {
      const user = users.find((u) => u.id === id)
      if (user) setResetResult({ email: user.email, temporaryPassword: data.temporaryPassword })
    },
  })

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: number; role: string }) =>
      api.patch(`/admin/users/${id}/role`, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })

  const currentUser = getCurrentUser()

  return (
    <div className="p-8 space-y-6 fade-up">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-headline font-bold text-2xl" style={{ color: 'var(--m3-on-surface)' }}>Users</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>{users.length} user{users.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={() => { setShowCreate(true); setError('') }}
          className="btn-primary flex items-center gap-2 py-3 px-4 rounded-xl font-headline font-bold text-sm transition-all active:scale-[0.98]"
          style={{ background: 'var(--m3-on-surface)', color: 'var(--m3-surface)' }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>person_add</span>
          New User
        </button>
      </div>

      {/* Create user form */}
      {showCreate && (
        <div className="rounded-2xl p-5" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          <p className="font-headline font-semibold text-sm mb-3" style={{ color: 'var(--m3-on-surface)' }}>New User</p>
          {error && (
            <div className="rounded-xl px-4 py-2 text-sm mb-3" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--m3-down)' }}>{error}</div>
          )}
          <div className="flex gap-3">
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="user@example.com"
              className="input-sig flex-1"
              onKeyDown={(e) => e.key === 'Enter' && newEmail && createMutation.mutate(newEmail)}
            />
            <button
              onClick={() => newEmail && createMutation.mutate(newEmail)}
              disabled={!newEmail || createMutation.isPending}
              className="btn-primary px-4 py-2 rounded-xl text-sm font-semibold transition-all"
              style={{ background: 'var(--m3-primary)', color: 'var(--m3-on-primary)' }}
            >
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-2 rounded-xl text-sm" style={{ color: 'var(--m3-secondary)' }}>
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
        <div className="rounded-2xl p-5" style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.3)' }}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-semibold text-sm mb-1" style={{ color: 'var(--m3-on-surface)' }}>
                User <strong>{createdUser.email}</strong> created
              </p>
              <p className="text-xs mb-3" style={{ color: 'var(--m3-secondary)' }}>
                Share this temporary password. It will not be shown again.
              </p>
              <div className="flex items-center gap-3">
                <code
                  className="font-mono text-base px-4 py-2 rounded-xl select-all"
                  style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-on-surface)', letterSpacing: '0.05em' }}
                >
                  {createdUser.temporaryPassword}
                </code>
                <button
                  onClick={() => navigator.clipboard.writeText(createdUser.temporaryPassword)}
                  className="text-xs px-3 py-2 rounded-lg"
                  style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)' }}
                >
                  Copy
                </button>
              </div>
            </div>
            <button onClick={() => setCreatedUser(null)} style={{ color: 'var(--m3-secondary)', fontSize: '18px', lineHeight: 1 }}>×</button>
          </div>
        </div>
      )}

      {/* Reset password result */}
      {resetResult && (
        <div className="rounded-2xl p-5" style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.3)' }}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-semibold text-sm mb-1" style={{ color: 'var(--m3-on-surface)' }}>
                Password reset for <strong>{resetResult.email}</strong>
              </p>
              <p className="text-xs mb-3" style={{ color: 'var(--m3-secondary)' }}>
                New temporary password (shown once):
              </p>
              <div className="flex items-center gap-3">
                <code
                  className="font-mono text-base px-4 py-2 rounded-xl select-all"
                  style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-on-surface)', letterSpacing: '0.05em' }}
                >
                  {resetResult.temporaryPassword}
                </code>
                <button
                  onClick={() => navigator.clipboard.writeText(resetResult.temporaryPassword)}
                  className="text-xs px-3 py-2 rounded-lg"
                  style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)' }}
                >
                  Copy
                </button>
              </div>
            </div>
            <button onClick={() => setResetResult(null)} style={{ color: 'var(--m3-secondary)', fontSize: '18px', lineHeight: 1 }}>×</button>
          </div>
        </div>
      )}

      {/* Users table */}
      <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
              {['Email', 'Role', 'Status', 'Created', ''].map((h) => (
                <th
                  key={h}
                  className={`px-4 py-3 font-mono text-xs uppercase tracking-wider ${h === '' ? 'text-right' : 'text-left'}`}
                  style={{ color: 'var(--m3-secondary)', background: 'var(--m3-surface-container)' }}
                >
                  {h}
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
                      {ROLES.find((r) => r.value === user.role)?.label ?? user.role}
                    </span>
                  ) : (
                    <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--m3-outline-variant)', width: 'fit-content' }}>
                      {ROLES.map((r) => {
                        const active = user.role === r.value
                        return (
                          <button
                            key={r.value}
                            type="button"
                            title={r.desc}
                            onClick={() => !active && roleMutation.mutate({ id: user.id, role: r.value })}
                            className={`text-xs font-medium px-3 py-1.5 transition-colors ${active ? 'selection-active' : ''}`}
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
                  {user.mustChangePassword ? (
                    <span className="text-xs font-medium px-2 py-0.5 rounded" style={{ background: 'rgba(234,179,8,0.12)', color: '#b45309' }}>
                      Temp password
                    </span>
                  ) : (
                    <span className="text-xs font-medium px-2 py-0.5 rounded" style={{ background: 'rgba(34,197,94,0.1)', color: '#15803d' }}>
                      Active
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--m3-secondary)' }}>
                  {new Date(user.createdAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => resetMutation.mutate(user.id)}
                      title="Reset password"
                      className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors text-xs"
                      style={{ color: 'var(--m3-secondary)' }}
                      onMouseEnter={(e) => { (e.currentTarget).style.background = 'var(--m3-surface-container-high)'; (e.currentTarget).style.color = 'var(--m3-on-surface)' }}
                      onMouseLeave={(e) => { (e.currentTarget).style.background = ''; (e.currentTarget).style.color = 'var(--m3-secondary)' }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>lock_reset</span>
                    </button>
                    {currentUser?.userId !== user.id && (
                      <button
                        onClick={() => setDeleteTarget(user)}
                        title="Delete user"
                        className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors text-xs"
                        style={{ color: 'var(--m3-secondary)' }}
                        onMouseEnter={(e) => { (e.currentTarget).style.background = 'var(--m3-error-container)'; (e.currentTarget).style.color = 'var(--m3-on-error-container)' }}
                        onMouseLeave={(e) => { (e.currentTarget).style.background = ''; (e.currentTarget).style.color = 'var(--m3-secondary)' }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm" style={{ color: 'var(--m3-secondary)' }}>No users yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {deleteTarget && (
        <ConfirmModal
          title="Delete user"
          message={`Delete user "${deleteTarget.email}"? This action cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={() => {
            deleteMutation.mutate(deleteTarget.id)
            setDeleteTarget(null)
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
