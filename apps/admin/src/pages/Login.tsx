import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, enterAfterSignIn, setSession, type AuthUser } from '../api/client'
import { useDarkMode } from '../hooks/useDarkMode'
import { Alert } from '../components/ui'

interface AuthConfig {
  passwordLogin: boolean
  /** `loginUrl` is on the host the identity provider returns to, which may differ from the one this page is on. */
  oidc: { label: string; loginUrl?: string } | null
}

const SSO_ERRORS: Record<string, string> = {
  oidc_failed: 'Single sign-on failed. Try again or contact an administrator.',
  oidc_no_account: 'No account matches your single sign-on identity. Ask an administrator to create one.',
}

const FEATURES = [
  { icon: 'bolt', label: 'Live status updates' },
  { icon: 'campaign', label: 'Incidents and maintenance notices' },
  { icon: 'notifications', label: 'Alerts through your notification channels' },
]

export default function LoginPage() {
  const navigate = useNavigate()
  const [isDark, toggleDark] = useDarkMode()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [challengeToken, setChallengeToken] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [searchParams] = useSearchParams()
  // An SSO sign-in of a user with 2FA comes back here for the code; the server holds the challenge in a cookie.
  const [ssoChallenge, setSsoChallenge] = useState(searchParams.get('two-factor') === 'sso')
  const codeStep = !!challengeToken || ssoChallenge
  const [authConfig, setAuthConfig] = useState<AuthConfig>({ passwordLogin: true, oidc: null })
  const ssoError = SSO_ERRORS[searchParams.get('error') ?? '']

  useEffect(() => {
    api.get<AuthConfig>('/auth/config').then(setAuthConfig).catch(() => { /* keep password-only default */ })
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (codeStep) {
        const user = await api.post<AuthUser>('/auth/2fa/verify', challengeToken ? { challengeToken, code } : { code })
        setSession(user)
        enterAfterSignIn(user, navigate)
      } else {
        const res = await api.post<AuthUser | { requiresTwoFactor: true; challengeToken: string }>('/auth/login', { email, password })
        if ('requiresTwoFactor' in res) {
          setChallengeToken(res.challengeToken)
          setPassword('')
        } else {
          setSession(res)
          enterAfterSignIn(res, navigate)
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

        {/* Features */}
        <ul className="relative space-y-3">
          {FEATURES.map((feature) => (
            <li key={feature.label} className="flex items-center gap-3 text-sm font-sans" style={{ color: 'var(--m3-on-surface-variant)' }}>
              <span
                className="material-symbols-outlined rounded-lg p-1.5"
                aria-hidden="true"
                style={{ fontSize: '18px', background: 'var(--admin-icon-container)', color: 'var(--admin-icon-color)' }}
              >
                {feature.icon}
              </span>
              {feature.label}
            </li>
          ))}
        </ul>
      </div>

      {/* Right form panel */}
      <div className="flex-1 relative flex items-center justify-center px-6 py-12">
        {/* Dark mode toggle */}
        <button
          type="button"
          onClick={toggleDark}
          className="btn-icon absolute top-5 right-5 w-9 h-9 rounded-full"
          aria-label="Toggle dark mode"
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            {isDark ? 'light_mode' : 'dark_mode'}
          </span>
        </button>

        <div className="w-full max-w-[400px]">
          {/* Mobile logo */}
          <div className="flex justify-center mb-8 lg:hidden">
            <img
              src={isDark ? '/admin/logo_dark.png' : '/admin/logo_light.png'}
              alt="BetterStatusPage"
              style={{ height: '32px', objectFit: 'contain' }}
            />
          </div>

          <div
            className="rounded-[20px] px-6 py-8 md:px-9 md:pt-9 md:pb-8"
            style={{
              background: 'var(--m3-surface-container-lowest)',
              border: '1px solid var(--m3-outline-variant)',
              boxShadow: '0 1px 2px rgba(19,27,46,0.04), 0 16px 40px rgba(19,27,46,0.06)',
            }}
          >

            <div className="mb-8">
              <h1 className="font-headline font-bold text-2xl" style={{ color: 'var(--m3-on-surface)' }}>
                Welcome back
              </h1>
              <p className="text-sm font-sans mt-1.5" style={{ color: 'var(--m3-secondary)' }}>
                Sign in to your admin panel
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {(error || ssoError) && <Alert tone="error">{error || ssoError}</Alert>}

              {authConfig.oidc && !codeStep && (
                <a href={authConfig.oidc.loginUrl ?? '/api/v1/auth/oidc/login'} className="btn btn-primary w-full h-12 font-headline font-bold text-[15px]">
                  <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '20px' }}>key</span>
                  {authConfig.oidc.label}
                </a>
              )}
              {authConfig.oidc && authConfig.passwordLogin && !codeStep && (
                <div className="flex items-center gap-3 text-xs font-sans" style={{ color: 'var(--m3-secondary)' }}>
                  <span className="flex-1 h-px" style={{ background: 'var(--m3-outline-variant)' }} />
                  or with email
                  <span className="flex-1 h-px" style={{ background: 'var(--m3-outline-variant)' }} />
                </div>
              )}

              {(authConfig.passwordLogin || codeStep) && <>

              {!codeStep && <div>
                <label htmlFor="login-email" className="block text-[13px] font-sans font-semibold mb-1.5" style={{ color: 'var(--m3-on-surface-variant)' }}>
                  Email
                </label>
                <input
                  id="login-email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="input-m3"
                  placeholder="name@company.com"
                />
              </div>}

              {!codeStep && <div>
                <label htmlFor="login-password" className="block text-[13px] font-sans font-semibold mb-1.5" style={{ color: 'var(--m3-on-surface-variant)' }}>
                  Password
                </label>
                <div className="relative">
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="input-m3"
                    style={{ paddingRight: '44px' }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((shown) => !shown)}
                    className="btn-icon absolute right-1 top-1/2 -translate-y-1/2 w-9 h-9 rounded-lg"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                  >
                    <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '20px' }}>{showPassword ? 'visibility_off' : 'visibility'}</span>
                  </button>
                </div>
              </div>}

              {codeStep && (
                <div>
                  <label htmlFor="login-two-factor-code" className="block text-[13px] font-sans font-semibold mb-1.5" style={{ color: 'var(--m3-on-surface-variant)' }}>
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
                    className="text-xs mt-2 rounded focus-ring hover:underline"
                    style={{ color: 'var(--m3-secondary)' }}
                    onClick={() => { setChallengeToken(''); setSsoChallenge(false); setCode('') }}
                  >
                    Back to sign-in
                  </button>
                </div>
              )}

              {/* One filled button per screen: next to SSO the password form's button is outlined. */}
              <button
                type="submit"
                disabled={loading}
                className={`btn ${authConfig.oidc && !codeStep ? 'btn-secondary h-11' : 'btn-primary h-12'} w-full mt-2 font-headline font-bold`}
              >
                {loading ? 'Signing in…' : codeStep ? 'Verify & sign in' : 'Sign in'}
              </button>
              </>}
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
