import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, clearSession, getCurrentUser, setSession, type AuthUser } from '../api/client'
import { CopyButton } from '../components/CopyButton'

interface TwoFactorSetup {
  secret: string
  uri: string
  qrDataUrl: string
  setupToken: string
}

export default function SettingsPage() {
  const navigate = useNavigate()
  const currentUser = getCurrentUser()
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [securityPassword, setSecurityPassword] = useState('')
  const [code, setCode] = useState('')
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(!!currentUser?.twoFactorEnabled)
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null)
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  function resetFeedback() {
    setError('')
    setMessage('')
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) { setError('Passwords do not match'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    resetFeedback()
    setLoading(true)
    try {
      const user = await api.post<AuthUser>('/auth/change-password', { currentPassword: current, newPassword: password })
      setSession(user)
      setCurrent('')
      setPassword('')
      setConfirm('')
      setMessage('Password changed. Other active sessions were signed out.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password')
    } finally { setLoading(false) }
  }

  async function beginTwoFactorSetup() {
    resetFeedback()
    setLoading(true)
    try {
      const result = await api.post<TwoFactorSetup>('/auth/2fa/setup', { currentPassword: securityPassword })
      setSetup(result)
      setCode('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start two-factor setup')
    } finally { setLoading(false) }
  }

  async function enableTwoFactor() {
    if (!setup) return
    resetFeedback()
    setLoading(true)
    try {
      const result = await api.post<{ recoveryCodes: string[] }>('/auth/2fa/enable', { setupToken: setup.setupToken, code })
      setRecoveryCodes(result.recoveryCodes)
      setTwoFactorEnabled(true)
      if (currentUser) setSession({ ...currentUser, twoFactorEnabled: true })
      setSetup(null)
      setSecurityPassword('')
      setCode('')
      setMessage('Two-factor authentication is enabled. Save the recovery codes now.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enable two-factor authentication')
    } finally { setLoading(false) }
  }

  async function disableTwoFactor() {
    resetFeedback()
    setLoading(true)
    try {
      await api.post('/auth/2fa/disable', { currentPassword: securityPassword, code })
      setTwoFactorEnabled(false)
      if (currentUser) setSession({ ...currentUser, twoFactorEnabled: false })
      setSecurityPassword('')
      setCode('')
      setRecoveryCodes([])
      setMessage('Two-factor authentication is disabled.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disable two-factor authentication')
    } finally { setLoading(false) }
  }

  async function logoutEverywhere() {
    resetFeedback()
    setLoading(true)
    try { await api.post('/auth/logout-all') }
    finally {
      clearSession()
      navigate('/admin/login')
    }
  }

  return (
    <div className="p-8 space-y-6 fade-up">
      <div>
        <h1 className="font-headline font-bold text-2xl" style={{ color: 'var(--m3-on-surface)' }}>Settings</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>Manage your account and sign-in security</p>
      </div>

      {(error || message) && (
        <div className="rounded-xl px-4 py-3 text-sm max-w-2xl" style={{
          background: error ? 'var(--m3-down-bg)' : 'rgba(34,197,94,0.08)',
          border: `1px solid ${error ? 'color-mix(in srgb, var(--m3-down) 25%, transparent)' : 'rgba(34,197,94,0.25)'}`,
          color: error ? 'var(--m3-down)' : 'var(--m3-up)',
        }}>
          {error || message}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-2 max-w-5xl">
        <section className="rounded-2xl p-6" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          <h2 className="font-headline font-semibold text-lg mb-1">Change password</h2>
          <p className="text-sm mb-5" style={{ color: 'var(--m3-secondary)' }}>Changing your password signs out every other active session.</p>
          <form onSubmit={changePassword} className="space-y-4">
            <PasswordField label="Current password" value={current} onChange={setCurrent} placeholder="Enter current password" />
            <PasswordField label="New password" value={password} onChange={setPassword} placeholder="Minimum 8 characters" minLength={8} />
            <PasswordField label="Confirm new password" value={confirm} onChange={setConfirm} placeholder="Repeat the new password" />
            <button type="submit" disabled={loading} className="btn-primary py-3 px-6 rounded-xl font-headline font-bold text-sm">
              {loading ? 'Saving…' : 'Update password'}
            </button>
          </form>
        </section>

        <section className="rounded-2xl p-6" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          <div className="flex items-center justify-between gap-3 mb-1">
            <h2 className="font-headline font-semibold text-lg">Two-factor authentication</h2>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={{
              background: twoFactorEnabled ? 'var(--m3-up-bg)' : 'var(--m3-surface-container-high)',
              color: twoFactorEnabled ? 'var(--m3-up)' : 'var(--m3-secondary)',
            }}>{twoFactorEnabled ? 'Enabled' : 'Disabled'}</span>
          </div>
          <p className="text-sm mb-5" style={{ color: 'var(--m3-secondary)' }}>Use any TOTP authenticator application. Recovery codes work once each.</p>

          {!twoFactorEnabled && !setup && recoveryCodes.length === 0 && (
            <div className="space-y-4">
              <PasswordField label="Current password" value={securityPassword} onChange={setSecurityPassword} placeholder="Confirm your password" />
              <button type="button" disabled={loading || !securityPassword} onClick={() => void beginTwoFactorSetup()} className="btn-primary py-3 px-6 rounded-xl font-headline font-bold text-sm">Set up 2FA</button>
            </div>
          )}

          {setup && (
            <div className="space-y-4">
              <div className="rounded-xl p-5 flex flex-col items-center text-center" style={{ background: 'var(--m3-surface-container)' }}>
                <p className="text-sm font-semibold mb-3">Scan this QR code with your authenticator app</p>
                <img
                  src={setup.qrDataUrl}
                  alt="QR code for two-factor authentication setup"
                  width={240}
                  height={240}
                  className="rounded-xl"
                  style={{ background: '#ffffff' }}
                />
                <details className="w-full mt-4 text-left">
                  <summary className="text-sm cursor-pointer" style={{ color: 'var(--m3-secondary)' }}>Cannot scan the QR code?</summary>
                  <p className="text-xs mt-3 mb-2" style={{ color: 'var(--m3-secondary)' }}>Enter this setup key manually:</p>
                  <code className="block text-sm break-all select-all">{setup.secret}</code>
                  <a href={setup.uri} className="inline-block text-sm mt-3 underline">Open in authenticator app</a>
                </details>
              </div>
              <TextField label="Authentication code" value={code} onChange={setCode} placeholder="123456" autoComplete="one-time-code" inputMode="numeric" />
              <button type="button" disabled={loading || !code} onClick={() => void enableTwoFactor()} className="btn-primary py-3 px-6 rounded-xl font-headline font-bold text-sm">Verify and enable</button>
            </div>
          )}

          {recoveryCodes.length > 0 && (
            <div className="space-y-4">
              <div className="rounded-xl p-4" style={{ background: 'var(--m3-surface-container)' }}>
                <p className="text-sm font-semibold mb-3">Recovery codes — store them somewhere safe</p>
                <div className="grid grid-cols-2 gap-2 font-mono text-sm select-all">
                  {recoveryCodes.map((recoveryCode) => <code key={recoveryCode}>{recoveryCode}</code>)}
                </div>
              </div>
              <CopyButton value={recoveryCodes.join('\n')} label="Copy codes" />
            </div>
          )}

          {twoFactorEnabled && recoveryCodes.length === 0 && (
            <div className="space-y-4">
              <PasswordField label="Current password" value={securityPassword} onChange={setSecurityPassword} placeholder="Confirm your password" />
              <TextField label="Authentication or recovery code" value={code} onChange={setCode} placeholder="Code" autoComplete="one-time-code" />
              <button type="button" disabled={loading || !securityPassword || !code} onClick={() => void disableTwoFactor()} className="btn-danger-outline px-5 py-3 rounded-xl font-semibold">Disable 2FA</button>
            </div>
          )}
        </section>
      </div>

      <section className="rounded-2xl p-6 max-w-5xl" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
        <h2 className="font-headline font-semibold text-lg">Active sessions</h2>
        <p className="text-sm mt-1 mb-4" style={{ color: 'var(--m3-secondary)' }}>Sign out this browser and every other active session for your account.</p>
        <button type="button" disabled={loading} onClick={() => void logoutEverywhere()} className="btn-danger-outline px-5 py-3 rounded-xl font-semibold">Sign out everywhere</button>
      </section>
    </div>
  )
}

function PasswordField({ label, value, onChange, placeholder, minLength }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; minLength?: number }) {
  return (
    <label className="block">
      <span className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>{label}</span>
      <input type="password" value={value} onChange={(event) => onChange(event.target.value)} required minLength={minLength} className="input-sig w-full" placeholder={placeholder} />
    </label>
  )
}

function TextField({ label, value, onChange, placeholder, autoComplete, inputMode }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; autoComplete?: string; inputMode?: 'numeric' }) {
  return (
    <label className="block">
      <span className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>{label}</span>
      <input type="text" inputMode={inputMode} value={value} onChange={(event) => onChange(event.target.value)} required className="input-sig w-full" placeholder={placeholder} autoComplete={autoComplete} />
    </label>
  )
}
