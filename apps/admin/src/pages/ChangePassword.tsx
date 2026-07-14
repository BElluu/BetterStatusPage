import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, setSession, type AuthUser } from '../api/client'

export default function ChangePasswordPage() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) { setError('Passwords do not match'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    setError('')
    setLoading(true)
    try {
      const res = await api.post<AuthUser>('/auth/change-password', { newPassword: password })
      setSession(res)
      navigate('/admin/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--m3-surface)' }}>
      <div className="w-full max-w-sm">
        <div className="rounded-2xl p-8" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          <div className="mb-6">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'var(--m3-on-surface)' }}>
              <span className="material-symbols-outlined" style={{ color: 'var(--m3-surface)', fontSize: '22px' }}>lock_reset</span>
            </div>
            <h1 className="font-headline font-bold text-2xl" style={{ color: 'var(--m3-on-surface)' }}>Set your password</h1>
            <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>You must change your temporary password before continuing.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="rounded-xl px-4 py-3 text-sm" style={{ background: 'rgba(255,77,106,0.08)', border: '1px solid rgba(255,77,106,0.2)', color: 'var(--m3-down)' }}>
                {error}
              </div>
            )}
            <div>
              <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>New Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="input-sig w-full"
                placeholder="Minimum 8 characters"
                autoFocus
              />
            </div>
            <div>
              <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Confirm Password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                className="input-sig w-full"
                placeholder="Repeat the password"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full py-3 rounded-xl font-headline font-bold text-sm transition-all active:scale-[0.98]"
            >
              {loading ? 'Saving…' : 'Set Password & Continue'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
