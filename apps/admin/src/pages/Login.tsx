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
      const res = await api.post<{ token: string }>('/auth/login', { email, password })
      setToken(res.token)
      navigate('/admin/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex bg-grid" style={{ background: 'var(--sig-bg)' }}>
      {/* Left panel — branding */}
      <div
        className="hidden lg:flex flex-col justify-between w-[420px] flex-shrink-0 p-12 relative overflow-hidden"
        style={{ background: 'linear-gradient(160deg, rgba(0,212,175,0.08) 0%, transparent 60%)', borderRight: '1px solid var(--sig-border)' }}
      >
        {/* Decorative orb */}
        <div
          className="absolute -top-24 -left-24 w-64 h-64 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(0,212,175,0.12) 0%, transparent 70%)' }}
        />
        <div
          className="absolute bottom-0 right-0 w-96 h-96 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(0,212,175,0.05) 0%, transparent 70%)' }}
        />

        {/* Logo */}
        <div className="relative flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center"
            style={{ background: 'var(--sig-teal-glow)', border: '1px solid rgba(0,212,175,0.35)' }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="3" fill="#00d4af" />
              <circle cx="9" cy="9" r="7" stroke="#00d4af" strokeWidth="1.2" strokeOpacity="0.4" fill="none" />
            </svg>
          </div>
          <span className="font-display font-bold text-lg" style={{ color: 'var(--sig-text)' }}>
            BetterStatusPage
          </span>
        </div>

        {/* Main text */}
        <div className="relative space-y-4">
          <h2 className="font-display font-bold text-4xl leading-tight" style={{ color: 'var(--sig-text)' }}>
            Monitor everything.<br />
            <span style={{ color: 'var(--sig-teal)' }}>Stay ahead</span> of issues.
          </h2>
          <p className="text-base leading-relaxed" style={{ color: 'var(--sig-text-muted)' }}>
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
              <div className="font-mono font-medium text-lg" style={{ color: 'var(--sig-teal)' }}>{stat.value}</div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--sig-text-muted)' }}>{stat.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Right panel — form */}
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <div className="flex items-center gap-2.5 mb-10 lg:hidden">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: 'var(--sig-teal-glow)', border: '1px solid rgba(0,212,175,0.3)' }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <circle cx="7" cy="7" r="2.5" fill="#00d4af" />
                <circle cx="7" cy="7" r="5.5" stroke="#00d4af" strokeWidth="1" strokeOpacity="0.4" fill="none" />
              </svg>
            </div>
            <span className="font-display font-bold" style={{ color: 'var(--sig-text)' }}>BetterStatusPage</span>
          </div>

          <div className="mb-8">
            <h1 className="font-display font-bold text-2xl" style={{ color: 'var(--sig-text)' }}>
              Welcome back
            </h1>
            <p className="text-sm mt-1.5" style={{ color: 'var(--sig-text-muted)' }}>
              Sign in to your admin panel
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div
                className="rounded-lg px-4 py-3 text-sm"
                style={{
                  background: 'rgba(255,77,106,0.08)',
                  border: '1px solid rgba(255,77,106,0.2)',
                  color: '#ff4d6a',
                }}
              >
                {error}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium mb-1.5 uppercase tracking-wider" style={{ color: 'var(--sig-text-muted)' }}>
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="input-sig"
                placeholder="admin@example.com"
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1.5 uppercase tracking-wider" style={{ color: 'var(--sig-text-muted)' }}>
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="input-sig"
                placeholder="••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full font-medium rounded-lg py-2.5 text-sm transition-all"
              style={{
                background: loading ? 'rgba(0,212,175,0.3)' : 'linear-gradient(135deg, #00d4af 0%, #00a88a 100%)',
                color: loading ? 'rgba(255,255,255,0.5)' : '#080d18',
                fontWeight: 600,
                opacity: loading ? 0.7 : 1,
                cursor: loading ? 'not-allowed' : 'pointer',
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
