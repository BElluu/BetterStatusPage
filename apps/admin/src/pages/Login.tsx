import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { setToken, api } from '../api/client'

export default function LoginPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await api.post<{ token: string; mustChangePassword?: boolean }>('/auth/login', { email, password })
      setToken(res.token)
      if (res.mustChangePassword) {
        navigate('/admin/change-password')
      } else {
        navigate('/admin/')
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
        <div className="relative flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-2xl flex items-center justify-center"
            style={{
              background: 'var(--m3-primary-fixed)',
              border: '1px solid color-mix(in srgb, var(--m3-primary) 30%, transparent)',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <circle cx="10" cy="10" r="3.5" fill="var(--m3-primary)" />
              <circle cx="10" cy="10" r="8.5" stroke="var(--m3-primary)" strokeWidth="1.2" strokeOpacity="0.35" fill="none" />
            </svg>
          </div>
          <span className="font-headline font-bold text-xl" style={{ color: 'var(--m3-on-surface)' }}>
            BetterStatusPage
          </span>
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
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <div className="flex items-center gap-3 mb-10 lg:hidden">
            <div
              className="w-9 h-9 rounded-2xl flex items-center justify-center"
              style={{
                background: 'var(--m3-primary-fixed)',
                border: '1px solid color-mix(in srgb, var(--m3-primary) 30%, transparent)',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <circle cx="9" cy="9" r="3" fill="var(--m3-primary)" />
                <circle cx="9" cy="9" r="7.5" stroke="var(--m3-primary)" strokeWidth="1.2" strokeOpacity="0.35" fill="none" />
              </svg>
            </div>
            <span className="font-headline font-bold text-lg" style={{ color: 'var(--m3-on-surface)' }}>
              BetterStatusPage
            </span>
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
                placeholder="••••••••"
              />
            </div>

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
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
