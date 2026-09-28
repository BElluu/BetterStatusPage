import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, clearSession, getCurrentUser, setSession, type AuthUser } from '../api/client'
import { ConfirmModal } from '../components/ConfirmModal'
import { CopyButton } from '../components/CopyButton'
import { Alert, PageContainer, PageHeader } from '../components/ui'

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
  const [confirmLogoutAll, setConfirmLogoutAll] = useState(false)

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
    <PageContainer>
      <PageHeader title="Settings" subtitle="Manage your account and sign-in security" />

      {(error || message) && (
        <Alert tone={error ? 'error' : 'success'} className="max-w-2xl">{error || message}</Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-2 max-w-5xl">
        <section className="rounded-2xl p-6" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          <h2 className="font-headline font-semibold text-lg mb-1">Change password</h2>
          <p className="text-sm mb-5" style={{ color: 'var(--m3-secondary)' }}>Changing your password signs out every other active session.</p>
          <form onSubmit={changePassword} className="space-y-4">
            <PasswordField label="Current password" value={current} onChange={setCurrent} placeholder="Enter current password" />
            <PasswordField label="New password" value={password} onChange={setPassword} placeholder="Minimum 8 characters" minLength={8} />
            <PasswordField label="Confirm new password" value={confirm} onChange={setConfirm} placeholder="Repeat the new password" />
            <button type="submit" disabled={loading} className="btn btn-primary">
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
            <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void beginTwoFactorSetup() }}>
              <PasswordField label="Current password" value={securityPassword} onChange={setSecurityPassword} placeholder="Confirm your password" />
              <button type="submit" disabled={loading || !securityPassword} className="btn btn-primary">Set up 2FA</button>
            </form>
          )}

          {setup && (
            <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void enableTwoFactor() }}>
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
              <button type="submit" disabled={loading || !code} className="btn btn-primary">Verify and enable</button>
            </form>
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
            <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void disableTwoFactor() }}>
              <PasswordField label="Current password" value={securityPassword} onChange={setSecurityPassword} placeholder="Confirm your password" />
              <TextField label="Authentication or recovery code" value={code} onChange={setCode} placeholder="Code" autoComplete="one-time-code" />
              <button type="submit" disabled={loading || !securityPassword || !code} className="btn btn-danger-outline">Disable 2FA</button>
            </form>
          )}
        </section>
      </div>

      <section className="rounded-2xl p-6 max-w-5xl" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
        <h2 className="font-headline font-semibold text-lg">Active sessions</h2>
        <p className="text-sm mt-1 mb-4" style={{ color: 'var(--m3-secondary)' }}>Sign out this browser and every other active session for your account.</p>
        <button type="button" disabled={loading} onClick={() => setConfirmLogoutAll(true)} className="btn btn-danger-outline">Sign out everywhere</button>
      </section>
      {confirmLogoutAll && (
        <ConfirmModal
          title="Sign out everywhere"
          message="Sign out this browser and every other active session for your account? You will need to sign in again."
          confirmLabel="Sign out everywhere"
          pending={loading}
          pendingLabel="Signing out…"
          onConfirm={() => void logoutEverywhere()}
          onCancel={() => setConfirmLogoutAll(false)}
        />
      )}
    </PageContainer>
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
