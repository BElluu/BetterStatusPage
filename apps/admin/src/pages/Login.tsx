import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, setSession, type AuthUser } from '../api/client'
import { useDarkMode } from '../hooks/useDarkMode'

export default function LoginPage() {
  const navigate = useNavigate()
  const [isDark, toggleDark] = useDarkMode()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [challengeToken, setChallengeToken] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (challengeToken) {
        const user = await api.post<AuthUser>('/auth/2fa/verify', { challengeToken, code })
        setSession(user)
        navigate(user.mustChangePassword ? '/admin/change-password' : '/admin/')
      } else {
        const res = await api.post<AuthUser | { requiresTwoFactor: true; challengeToken: string }>('/auth/login', { email, password })
        if ('requiresTwoFactor' in res) {
          setChallengeToken(res.challengeToken)
          setPassword('')
        } else {
          setSession(res)
          navigate(res.mustChangePassword ? '/admin/change-password' : '/admin/')
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex" style={{ background: 'var(--m3-surface)' }}>
      {/* Left branding panel */}
      <div
        className="hidden lg:flex flex-col justify-between w-[400px] flex-shrink-0 p-12 relative overflow-hidden"
        style={{
          background: 'var(--m3-surface-container-low)',
          borderRight: '1px solid var(--m3-outline-variant)',
        }}
      >
        {/* Decorative gradient blobs */}
        <div
          className="absolute -top-32 -left-32 w-80 h-80 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, color-mix(in srgb, var(--m3-primary) 12%, transparent) 0%, transparent 70%)' }}
        />
        <div
          className="absolute bottom-0 right-0 w-96 h-96 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, color-mix(in srgb, var(--m3-primary) 6%, transparent) 0%, transparent 70%)' }}
        />

        {/* Logo */}
        <div className="relative flex justify-center">
          <img
            src={isDark ? '/admin/logo_dark.png' : '/admin/logo_light.png'}
            alt="BetterStatusPage"
            style={{ height: '160px', objectFit: 'contain' }}
          />
        </div>

        {/* Main copy */}
        <div className="relative space-y-4">
          <h2 className="font-headline font-extrabold text-4xl leading-[1.1] tracking-tight" style={{ color: 'var(--m3-on-surface)' }}>
            Monitor everything.<br />
            <span style={{ color: 'var(--m3-primary)' }}>Stay ahead</span> of issues.
          </h2>
          <p className="text-base font-sans leading-relaxed" style={{ color: 'var(--m3-secondary)' }}>
            Real-time status pages, incident management, and uptime monitoring — all in one place.
          </p>
        </div>

        {/* Stats */}
        <div className="relative flex gap-8">
          {[
            { value: '99.9%', label: 'Avg Uptime' },
            { value: '<1s', label: 'Check Interval' },
            { value: 'Live', label: 'SSE Updates' },
          ].map((stat) => (
            <div key={stat.label}>
              <div className="font-mono font-semibold text-xl" style={{ color: 'var(--m3-primary)' }}>{stat.value}</div>
              <div className="text-xs font-sans mt-0.5" style={{ color: 'var(--m3-secondary)' }}>{stat.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Right form panel */}
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

        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <div className="flex items-center mb-10 lg:hidden">
            <img
              src={isDark ? '/admin/logo_dark.png' : '/admin/logo_light.png'}
              alt="BetterStatusPage"
              style={{ height: '32px', objectFit: 'contain' }}
            />
          </div>

          <div className="mb-8">
            <h1 className="font-headline font-bold text-2xl" style={{ color: 'var(--m3-on-surface)' }}>
              Welcome back
            </h1>
            <p className="text-sm font-sans mt-1.5" style={{ color: 'var(--m3-secondary)' }}>
              Sign in to your admin panel
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div
                className="rounded-xl px-4 py-3 text-sm font-sans"
                style={{
                  background: 'var(--m3-down-bg)',
                  border: '1px solid color-mix(in srgb, var(--m3-down) 30%, transparent)',
                  color: 'var(--m3-down)',
                }}
              >
                {error}
              </div>
            )}

            {!challengeToken && <div>
              <label htmlFor="login-email" className="block text-xs font-sans font-semibold mb-1.5 uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>
                Email
              </label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="input-m3"
                placeholder="admin@example.com"
              />
            </div>}

            {!challengeToken && <div>
              <label htmlFor="login-password" className="block text-xs font-sans font-semibold mb-1.5 uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>
                Password
              </label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="input-m3"
                placeholder="••••••••"
              />
            </div>}

            {challengeToken && (
              <div>
                <label htmlFor="login-two-factor-code" className="block text-xs font-sans font-semibold mb-1.5 uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>
                  Authentication code
                </label>
                <input
                  id="login-two-factor-code"
                  type="text"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  autoFocus
                  className="input-m3"
                  placeholder="6-digit code or recovery code"
                />
                <button
                  type="button"
                  className="text-xs mt-2"
                  style={{ color: 'var(--m3-secondary)' }}
                  onClick={() => { setChallengeToken(''); setCode('') }}
                >
                  Back to password sign-in
                </button>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full font-sans font-semibold rounded-xl py-3 text-sm transition-all mt-2"
              style={{
                background: loading
                  ? 'var(--m3-surface-container-high)'
                  : 'var(--m3-primary)',
                color: loading ? 'var(--m3-secondary)' : 'var(--m3-on-primary)',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.7 : 1,
              }}
            >
              {loading ? 'Signing in…' : challengeToken ? 'Verify & sign in' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
