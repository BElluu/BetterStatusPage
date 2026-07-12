import { useState } from 'react'
import { api, setToken } from '../api/client'

export default function SettingsPage() {
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) { setError('Passwords do not match'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    setError('')
    setLoading(true)
    try {
      const res = await api.post<{ token: string }>('/auth/change-password', {
        currentPassword: current,
        newPassword: password,
      })
      setToken(res.token, false)
      setCurrent('')
      setPassword('')
      setConfirm('')
      setSuccess(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-8 space-y-6 fade-up">
      <div>
        <h1 className="font-headline font-bold text-2xl" style={{ color: 'var(--m3-on-surface)' }}>Settings</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>Manage your account</p>
      </div>

      <div className="rounded-2xl p-6 max-w-md" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
        <p className="font-headline font-semibold text-sm mb-4" style={{ color: 'var(--m3-on-surface)' }}>Change Password</p>

        {success && (
          <div className="rounded-xl px-4 py-3 text-sm mb-4" style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', color: '#15803d' }}>
            Password changed successfully.
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-xl px-4 py-3 text-sm" style={{ background: 'rgba(255,77,106,0.08)', border: '1px solid rgba(255,77,106,0.2)', color: 'var(--m3-down)' }}>
              {error}
            </div>
          )}
          <div>
            <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Current Password</label>
            <input
              type="password"
              value={current}
              onChange={(e) => { setCurrent(e.target.value); setSuccess(false) }}
              required
              className="input-sig w-full"
              placeholder="Enter current password"
            />
          </div>
          <div>
            <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>New Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setSuccess(false) }}
              required
              minLength={8}
              className="input-sig w-full"
              placeholder="Minimum 8 characters"
            />
          </div>
          <div>
            <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Confirm New Password</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => { setConfirm(e.target.value); setSuccess(false) }}
              required
              className="input-sig w-full"
              placeholder="Repeat the new password"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="btn-primary py-3 px-6 rounded-xl font-headline font-bold text-sm transition-all active:scale-[0.98]"
          >
            {loading ? 'Saving…' : 'Update Password'}
          </button>
        </form>
      </div>
    </div>
  )
}
