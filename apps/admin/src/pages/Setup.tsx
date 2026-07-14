import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, isAuthenticated, setSession, type AuthUser } from '../api/client'
import { useDarkMode } from '../hooks/useDarkMode'

const STEPS = [
  { n: 1, label: 'Database' },
  { n: 2, label: 'Admin Account' },
  { n: 3, label: 'Done' },
]

export default function SetupPage() {
  const navigate = useNavigate()
  const [isDark, toggleDark] = useDarkMode()
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    fetch('/api/v1/setup/status')
      .then((r) => r.json())
      .then((data: { needsSetup: boolean }) => {
        if (!data.needsSetup) navigate(isAuthenticated() ? '/admin/' : '/admin/login', { replace: true })
        else setChecking(false)
      })
      .catch(() => setChecking(false))
  }, [navigate])

  // Step 2 fields
  const [email, setEmail]         = useState('')
  const [password, setPassword]     = useState('')
  const [confirm, setConfirm]       = useState('')
  const [error, setError]           = useState('')
  const [loading, setLoading]       = useState(false)
  const [mariaTooltip, setMariaTooltip] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== confirm) { setError('Passwords do not match'); return }
    if (password.length < 8)  { setError('Password must be at least 8 characters'); return }
    setLoading(true)
    try {
      const res = await api.post<AuthUser>('/setup/complete', { email, password })
      setSession(res)
      setStep(3)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed')
    } finally {
      setLoading(false)
    }
  }

  if (checking) return null

  return (
    <div className="min-h-screen flex" style={{ background: 'var(--m3-surface)' }}>

      {/* ── Left branding panel ── */}
      <div
        className="hidden lg:flex flex-col justify-between w-[400px] flex-shrink-0 p-12 relative overflow-hidden"
        style={{
          background: 'var(--m3-surface-container-low)',
          borderRight: '1px solid var(--m3-outline-variant)',
        }}
      >
        {/* Decorative blobs */}
        <div className="absolute -top-32 -left-32 w-80 h-80 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, color-mix(in srgb, var(--m3-primary) 12%, transparent) 0%, transparent 70%)' }} />
        <div className="absolute bottom-0 right-0 w-96 h-96 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, color-mix(in srgb, var(--m3-primary) 6%, transparent) 0%, transparent 70%)' }} />

        {/* Logo */}
        <div className="relative flex justify-center">
          <img
            src={isDark ? '/admin/logo_dark.png' : '/admin/logo_light.png'}
            alt="BetterStatusPage"
            style={{ height: '160px', objectFit: 'contain' }}
          />
        </div>

        {/* Headline */}
        <div className="relative space-y-3">
          <p className="font-label text-xs uppercase tracking-widest" style={{ color: 'var(--m3-secondary)' }}>
            First-time setup
          </p>
          <h2 className="font-headline font-extrabold text-4xl leading-[1.1] tracking-tight" style={{ color: 'var(--m3-on-surface)' }}>
            Set up your<br />
            <span style={{ color: 'var(--m3-primary)' }}>instance.</span>
          </h2>
          <p className="text-sm font-sans leading-relaxed" style={{ color: 'var(--m3-secondary)' }}>
            Configure your database and create your administrator account to get started.
          </p>
        </div>

        {/* Progress steps */}
        <div className="relative flex flex-col gap-0">
          {STEPS.map((s, i) => {
            const isDone   = step > s.n
            const isActive = step === s.n
            const isPending = step < s.n

            return (
              <div key={s.n}>
                <div className="flex items-center gap-4">
                  {/* Circle */}
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-sm font-bold transition-all duration-300"
                    style={{
                      background: isDone
                        ? 'var(--m3-primary)'
                        : isActive
                        ? 'var(--m3-primary)'
                        : 'transparent',
                      border: isPending
                        ? '2px solid var(--m3-outline-variant)'
                        : '2px solid var(--m3-primary)',
                      color: isDone || isActive
                        ? 'var(--m3-on-primary)'
                        : 'var(--m3-secondary)',
                    }}
                  >
                    {isDone ? (
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path d="M2.5 7L5.5 10L11.5 4" stroke="var(--m3-on-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : s.n}
                  </div>

                  {/* Label */}
                  <span
                    className="font-sans text-sm transition-all duration-300"
                    style={{
                      fontWeight: isActive ? 700 : 400,
                      color: isActive
                        ? 'var(--m3-on-surface)'
                        : isDone
                        ? 'var(--m3-primary)'
                        : 'var(--m3-secondary)',
                    }}
                  >
                    {s.label}
                  </span>
                </div>

                {/* Connector */}
                {i < STEPS.length - 1 && (
                  <div className="ml-4 w-px h-6 my-1"
                    style={{ background: step > s.n ? 'var(--m3-primary)' : 'var(--m3-outline-variant)' }} />
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Right panel ── */}
      <div className="flex-1 relative flex items-center justify-center px-6 py-12">
        {/* Dark mode toggle */}
        <button
          onClick={toggleDark}
          className="absolute top-5 right-5 p-2 rounded-full transition-all"
          style={{ color: 'var(--m3-secondary)' }}
          onMouseEnter={(e) => { (e.currentTarget).style.background = 'var(--m3-surface-container)' }}
          onMouseLeave={(e) => { (e.currentTarget).style.background = '' }}
          aria-label="Toggle dark mode"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>
            {isDark ? 'light_mode' : 'dark_mode'}
          </span>
        </button>

        <div className="w-full max-w-md">

          {/* Mobile logo */}
          <div className="flex items-center mb-10 lg:hidden">
            <img
              src={isDark ? '/admin/logo_dark.png' : '/admin/logo_light.png'}
              alt="BetterStatusPage"
              style={{ height: '32px', objectFit: 'contain' }}
            />
          </div>

          {/* ── STEP 1: Database ── */}
          {step === 1 && (
            <div>
              <div className="mb-8">
                <p className="font-label text-xs uppercase tracking-widest mb-1" style={{ color: 'var(--m3-secondary)' }}>Step 1 of 2</p>
                <h1 className="font-headline font-bold text-2xl" style={{ color: 'var(--m3-on-surface)' }}>
                  Choose a database
                </h1>
                <p className="text-sm font-sans mt-1.5" style={{ color: 'var(--m3-secondary)' }}>
                  Select where your data will be stored.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-8">
                {/* SQLite card — always selected */}
                <div
                  className="relative rounded-2xl p-5 cursor-pointer transition-all duration-200"
                  style={{
                    background: 'var(--m3-surface-container-low)',
                    border: '2px solid var(--m3-primary)',
                    boxShadow: '0 0 0 4px color-mix(in srgb, var(--m3-primary) 12%, transparent)',
                  }}
                >
                  {/* Selected checkmark */}
                  <div
                    className="absolute top-3 right-3 w-5 h-5 rounded-full flex items-center justify-center"
                    style={{ background: 'var(--m3-primary)' }}
                  >
                    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                      <path d="M2 5.5L4.5 8L9 3" stroke="var(--m3-on-primary)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>

                  {/* DB icon */}
                  <div className="mb-4">
                    <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
                      <ellipse cx="18" cy="10" rx="12" ry="5" fill="color-mix(in srgb, var(--m3-primary) 20%, transparent)" stroke="var(--m3-primary)" strokeWidth="1.5" />
                      <path d="M6 10v8c0 2.76 5.37 5 12 5s12-2.24 12-5v-8" stroke="var(--m3-primary)" strokeWidth="1.5" fill="none" />
                      <path d="M6 18v8c0 2.76 5.37 5 12 5s12-2.24 12-5v-8" stroke="var(--m3-primary)" strokeWidth="1.5" fill="none" />
                      <ellipse cx="18" cy="26" rx="12" ry="5" fill="color-mix(in srgb, var(--m3-primary) 10%, transparent)" />
                    </svg>
                  </div>

                  <h3 className="font-headline font-bold text-base mb-1" style={{ color: 'var(--m3-on-surface)' }}>SQLite</h3>
                  <p className="font-sans text-xs leading-relaxed" style={{ color: 'var(--m3-secondary)' }}>
                    Built-in · No configuration needed
                  </p>
                </div>

                {/* MariaDB card — disabled */}
                <div
                  className="relative rounded-2xl p-5"
                  style={{
                    background: 'var(--m3-surface-container-low)',
                    border: '2px solid var(--m3-outline-variant)',
                    opacity: 0.45,
                    cursor: 'not-allowed',
                  }}
                  onMouseEnter={() => setMariaTooltip(true)}
                  onMouseLeave={() => setMariaTooltip(false)}
                >
                  {/* Soon badge */}
                  <div
                    className="absolute top-3 right-3 px-2 py-0.5 rounded-full font-mono text-[10px] font-bold uppercase tracking-wider"
                    style={{ background: 'var(--m3-surface-container-highest)', color: 'var(--m3-secondary)' }}
                  >
                    Soon
                  </div>

                  {/* DB icon */}
                  <div className="mb-4">
                    <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
                      <ellipse cx="18" cy="10" rx="12" ry="5" fill="color-mix(in srgb, var(--m3-secondary) 15%, transparent)" stroke="var(--m3-secondary)" strokeWidth="1.5" />
                      <path d="M6 10v8c0 2.76 5.37 5 12 5s12-2.24 12-5v-8" stroke="var(--m3-secondary)" strokeWidth="1.5" fill="none" />
                      <path d="M6 18v8c0 2.76 5.37 5 12 5s12-2.24 12-5v-8" stroke="var(--m3-secondary)" strokeWidth="1.5" fill="none" />
                      <ellipse cx="18" cy="26" rx="12" ry="5" fill="color-mix(in srgb, var(--m3-secondary) 8%, transparent)" />
                    </svg>
                  </div>

                  <h3 className="font-headline font-bold text-base mb-1" style={{ color: 'var(--m3-on-surface)' }}>MariaDB / MySQL</h3>
                  <p className="font-sans text-xs leading-relaxed" style={{ color: 'var(--m3-secondary)' }}>
                    External database
                  </p>

                  {/* Tooltip */}
                  {mariaTooltip && (
                    <div
                      className="absolute -top-9 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg text-xs font-sans font-medium whitespace-nowrap pointer-events-none z-10"
                      style={{
                        background: 'var(--m3-on-surface)',
                        color: 'var(--m3-surface)',
                        opacity: 1,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                      }}
                    >
                      Coming soon
                      <div
                        className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0"
                        style={{ borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '5px solid var(--m3-on-surface)' }}
                      />
                    </div>
                  )}
                </div>
              </div>

              <button
                onClick={() => setStep(2)}
                className="btn-primary w-full font-sans font-semibold rounded-xl py-3 text-sm transition-all"
                style={{ background: 'var(--m3-primary)', color: 'var(--m3-on-primary)', cursor: 'pointer' }}
              >
                Continue
              </button>
            </div>
          )}

          {/* ── STEP 2: Admin account ── */}
          {step === 2 && (
            <div>
              <div className="mb-8">
                <button
                  onClick={() => { setError(''); setStep(1) }}
                  className="flex items-center gap-1.5 text-xs font-sans font-semibold mb-4 transition-opacity hover:opacity-70"
                  style={{ color: 'var(--m3-secondary)' }}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M9 2L4 7l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Back
                </button>
                <p className="font-label text-xs uppercase tracking-widest mb-1" style={{ color: 'var(--m3-secondary)' }}>Step 2 of 2</p>
                <h1 className="font-headline font-bold text-2xl" style={{ color: 'var(--m3-on-surface)' }}>
                  Create admin account
                </h1>
                <p className="text-sm font-sans mt-1.5" style={{ color: 'var(--m3-secondary)' }}>
                  This will be the primary administrator of your instance.
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <div
                    className="rounded-xl px-4 py-3 text-sm font-sans"
                    style={{
                      background: 'var(--m3-error-container)',
                      border: '1px solid color-mix(in srgb, var(--m3-error) 30%, transparent)',
                      color: 'var(--m3-on-error-container)',
                    }}
                  >
                    {error}
                  </div>
                )}

                <div>
                  <label className="block text-xs font-sans font-semibold mb-1.5 uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>
                    Email
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="input-m3"
                    placeholder="admin@example.com"
                    autoFocus
                  />
                </div>

                <div>
                  <label className="block text-xs font-sans font-semibold mb-1.5 uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>
                    Password
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="input-m3"
                    placeholder="Min. 8 characters"
                  />
                </div>

                <div>
                  <label className="block text-xs font-sans font-semibold mb-1.5 uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>
                    Confirm Password
                  </label>
                  <input
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    className="input-m3"
                    placeholder="Repeat password"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="btn-primary w-full font-sans font-semibold rounded-xl py-3 text-sm transition-all mt-2"
                  style={{
                    background: loading ? 'var(--m3-surface-container-high)' : 'var(--m3-primary)',
                    color: loading ? 'var(--m3-secondary)' : 'var(--m3-on-primary)',
                    cursor: loading ? 'not-allowed' : 'pointer',
                    opacity: loading ? 0.7 : 1,
                  }}
                >
                  {loading ? 'Creating account…' : 'Create Account'}
                </button>
              </form>
            </div>
          )}

          {/* ── STEP 3: Done ── */}
          {step === 3 && (
            <div className="text-center">
              {/* Success ring */}
              <div className="flex justify-center mb-8">
                <div
                  className="w-20 h-20 rounded-full flex items-center justify-center"
                  style={{
                    background: 'color-mix(in srgb, var(--m3-primary) 12%, transparent)',
                    border: '2px solid color-mix(in srgb, var(--m3-primary) 40%, transparent)',
                  }}
                >
                  <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
                    <path d="M8 18L15 25L28 11" stroke="var(--m3-primary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </div>

              <h1 className="font-headline font-bold text-2xl mb-3" style={{ color: 'var(--m3-on-surface)' }}>
                You're all set.
              </h1>
              <p className="font-sans text-sm leading-relaxed mb-2" style={{ color: 'var(--m3-secondary)' }}>
                Your BetterStatusPage instance is ready.
              </p>
              <p className="font-mono text-xs mb-10" style={{ color: 'var(--m3-secondary)' }}>
                {email}
              </p>

              {/* Summary */}
              <div
                className="rounded-2xl p-5 mb-8 text-left space-y-3"
                style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}
              >
                {[
                  { icon: 'M6 10v8c0 2.76 5.37 5 12 5s12-2.24 12-5v-8', label: 'Database', value: 'SQLite' },
                  { icon: 'M18 4a7 7 0 100 14A7 7 0 0018 4zm-2 18h4m-2-4v4', label: 'Admin account', value: email },
                  { icon: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5', label: 'Role', value: 'Administrator' },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between gap-4">
                    <span className="font-sans text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>
                      {row.label}
                    </span>
                    <span className="font-mono text-xs" style={{ color: 'var(--m3-on-surface)' }}>
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>

              <button
                onClick={() => navigate('/admin/')}
                className="btn-primary w-full font-sans font-semibold rounded-xl py-3 text-sm transition-all"
                style={{ background: 'var(--m3-primary)', color: 'var(--m3-on-primary)', cursor: 'pointer' }}
              >
                Go to Dashboard
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
