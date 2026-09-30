import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, getCurrentUser, setSession, type AuthUser } from '../api/client'
import { Alert, Field } from '../components/ui'

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
              <span className="material-symbols-outlined" aria-hidden="true" style={{ color: 'var(--m3-surface)', fontSize: '22px' }}>lock_reset</span>
            </div>
            <h1 className="font-headline font-bold text-2xl" style={{ color: 'var(--m3-on-surface)' }}>Set your password</h1>
            <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>
              {getCurrentUser()?.authMethod === 'oidc'
                ? 'Password sign-in is enabled, so set your own password to replace the temporary one before continuing.'
                : 'You must change your temporary password before continuing.'}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <Alert tone="error">{error}</Alert>}
            <Field label="New Password" hint="Minimum 8 characters">
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="input-sig w-full"
                placeholder="Minimum 8 characters"
                autoFocus
              />
            </Field>
            <Field label="Confirm Password">
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                className="input-sig w-full"
                placeholder="Repeat the password"
              />
            </Field>
            <button
              type="submit"
              disabled={loading}
              className="btn btn-primary w-full py-3 font-headline font-bold"
            >
              {loading ? 'Saving…' : 'Set Password & Continue'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
