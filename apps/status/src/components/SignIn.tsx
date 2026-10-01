import { useEffect, useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Branding, TranslationKey } from '@bsp/shared'
import { ApiError, getJSON, postJSON } from '../api'
import { resolveBrandingCssVariables, resolveBrandingCustomCss, resolveBrandingLogoUrl } from '../branding'
import { useDarkMode } from '../hooks/useDarkMode'
import { useLocale } from '../i18n/LocaleContext'
import { LanguageSwitcher } from './LanguageSwitcher'

interface AuthConfig {
  passwordLogin: boolean
  /** `loginUrl` is on the host the identity provider returns to, which may differ from the one this page is on. */
  oidc: { label: string; loginUrl?: string } | null
}

interface SignedInUser {
  mustChangePassword: boolean
}

type LoginResponse = SignedInUser | { requiresTwoFactor: true; challengeToken: string }

const SSO_ERRORS: Record<string, TranslationKey> = {
  oidc_failed: 'signIn.ssoFailed',
  oidc_no_account: 'signIn.ssoNoAccount',
}

/** Reads what an SSO sign-in sent back in the URL once, then removes it so a reload starts clean. */
function takeSsoReturn(): { twoFactor: boolean; error: TranslationKey | null } {
  const params = new URLSearchParams(window.location.search)
  const result = { twoFactor: params.get('two-factor') === 'sso', error: SSO_ERRORS[params.get('sign-in-error') ?? ''] ?? null }
  if (params.has('two-factor') || params.has('sign-in-error')) {
    params.delete('two-factor')
    params.delete('sign-in-error')
    const query = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
  }
  return result
}

const MIN_PASSWORD_LENGTH = 8

/**
 * The sign-in screen of a private status page, in the page's own branding. Any user can sign in here, with a
 * password (and their second factor) or through SSO; `onSignedIn` then shows the page. A temporary password is
 * replaced here too, so a viewer never has to open the admin console. `passwordChangeRequired` starts there,
 * for a session that already exists.
 */
export function SignIn({ branding, passwordChangeRequired = false, onSignedIn }: {
  branding: Branding | null
  passwordChangeRequired?: boolean
  onSignedIn: () => void
}) {
  const { t } = useLocale()
  const [savedDarkMode, toggleDark] = useDarkMode()
  const [ssoReturn] = useState(takeSsoReturn)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [challengeToken, setChallengeToken] = useState('')
  // An SSO sign-in of a user with 2FA comes back for the code; the server holds the challenge in a cookie.
  const [ssoChallenge, setSsoChallenge] = useState(ssoReturn.twoFactor)
  const [error, setError] = useState<TranslationKey | null>(ssoReturn.error)
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [settingPassword, setSettingPassword] = useState(passwordChangeRequired)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const ids = useId()
  const codeStep = !settingPassword && (!!challengeToken || ssoChallenge)
  const signInStep = !settingPassword && !codeStep

  const { data: config } = useQuery<AuthConfig>({
    queryKey: ['auth-config'],
    queryFn: () => getJSON<AuthConfig>('/api/v1/auth/config'),
  })
  const passwordLogin = config?.passwordLogin ?? true

  const brandingEnabled = !!branding?.enabled
  const isDark = brandingEnabled ? false : savedDarkMode
  const siteName = branding?.siteName || t('page.defaultTitle')
  const logoUrl = resolveBrandingLogoUrl(branding, isDark, brandingEnabled)
  const customCss = resolveBrandingCustomCss(branding)
  const cssVars = brandingEnabled ? resolveBrandingCssVariables(branding!) as React.CSSProperties : {}

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
  }, [isDark])
  useEffect(() => {
    document.title = siteName
  }, [siteName])

  function finish(user: SignedInUser) {
    // A temporary password has to be replaced before the page answers.
    if (user.mustChangePassword) {
      setPassword('')
      setSettingPassword(true)
    } else {
      onSignedIn()
    }
  }

  async function replaceTemporaryPassword() {
    if (newPassword.length < MIN_PASSWORD_LENGTH) { setError('signIn.passwordTooShort'); return }
    if (newPassword !== confirmPassword) { setError('signIn.passwordMismatch'); return }
    await postJSON('/api/v1/auth/change-password', { newPassword })
    onSignedIn()
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setLoading(true)
    try {
      if (settingPassword) {
        await replaceTemporaryPassword()
      } else if (codeStep) {
        finish(await postJSON<SignedInUser>('/api/v1/auth/2fa/verify', challengeToken ? { challengeToken, code } : { code }))
      } else {
        const response = await postJSON<LoginResponse>('/api/v1/auth/login', { email, password })
        if ('requiresTwoFactor' in response) {
          setChallengeToken(response.challengeToken)
          setPassword('')
        } else {
          finish(response)
        }
      }
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'signIn.invalid' : 'signIn.error')
    } finally {
      setLoading(false)
    }
  }

  function backToSignIn() {
    setChallengeToken('')
    setSsoChallenge(false)
    setCode('')
    setError(null)
  }

  // The button keeps the label set in the SSO settings, as on the admin sign-in page.
  const sso = config?.oidc ? { label: config.oidc.label, url: `${config.oidc.loginUrl ?? '/api/v1/auth/oidc/login'}?returnTo=status` } : null
  // One filled button per screen: next to SSO the password form's button is outlined.
  const outlinedSubmit = !!sso && signInStep
  const label = 'block text-[13px] font-semibold mb-1.5'
  const labelColor = { color: 'var(--bsp-text-muted)' }
  const input: React.CSSProperties = {
    width: '100%', height: '44px', padding: '0 14px', borderRadius: '10px',
    background: 'var(--m3-surface-container-lowest)', color: 'var(--bsp-text)', fontSize: '14px',
  }
  const buttonBase = 'bsp-action w-full px-4 rounded-xl font-headline font-bold transition-all active:scale-[0.98] inline-flex items-center justify-center gap-2.5'
  const button = `${buttonBase} h-12 text-[15px]`
  const hairline = { background: 'color-mix(in srgb, var(--bsp-card-border) 55%, transparent)' }

  return (
    <div className="bsp-page bsp-sign-in flex flex-col" style={{ ...cssVars, background: 'var(--bsp-bg)', minHeight: '100vh' }}>
      {customCss && <style>{customCss}</style>}
      <header className="flex justify-end items-center gap-3 px-4 md:px-8 py-4 md:py-5">
        <LanguageSwitcher />
        {!brandingEnabled && (
          <button
            type="button"
            onClick={toggleDark}
            className="bsp-ghost p-2 rounded-full transition-all active:scale-95"
            style={{ color: 'var(--m3-secondary)' }}
            aria-label={t('page.toggleDarkMode')}
          >
            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '22px' }}>{isDark ? 'light_mode' : 'dark_mode'}</span>
          </button>
        )}
      </header>

      <main className="flex-1 flex flex-col items-center px-4 pt-4 pb-16 md:pt-8 gap-5">
        <div
          className="bsp-sign-in-card w-full max-w-[400px] rounded-[20px] px-6 py-8 md:px-9 md:pt-9 md:pb-8 flex flex-col gap-6"
          style={{
            background: 'var(--m3-surface-container-lowest)',
            border: '1px solid color-mix(in srgb, var(--bsp-card-border) 55%, transparent)',
            boxShadow: '0 1px 2px rgba(19,27,46,0.04), 0 16px 40px rgba(19,27,46,0.06)',
          }}
        >
          <div className="flex flex-col items-center gap-3.5 text-center">
            {branding?.logoType === 'text' && branding.logoText ? (
              <span className="bsp-site-name font-headline font-extrabold" style={{ fontSize: '22px', color: 'var(--bsp-text)', letterSpacing: '-0.01em' }}>{branding.logoText}</span>
            ) : (
              <img src={logoUrl ?? (isDark ? '/logo_dark.png' : '/logo_light.png')} alt={siteName} style={{ height: '44px', maxWidth: '220px', objectFit: 'contain' }} />
            )}
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
              style={{ background: 'var(--m3-surface-container)', color: 'var(--bsp-text-muted)' }}
            >
              <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '14px' }}>lock</span>
              {t('signIn.privateBadge')}
            </span>
            <div className="flex flex-col gap-1.5">
              <h1 className="font-headline font-bold text-2xl leading-tight" style={{ color: 'var(--bsp-text)', letterSpacing: '-0.01em' }}>{t(settingPassword ? 'signIn.setPasswordTitle' : 'signIn.title')}</h1>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--bsp-text-muted)' }}>{t(settingPassword ? 'signIn.setPasswordIntro' : 'signIn.intro')}</p>
            </div>
          </div>

          {error && (
            <p role="alert" className="flex gap-2.5 items-start text-[13px] leading-snug rounded-xl px-3.5 py-3" style={{ background: 'color-mix(in srgb, var(--bsp-down) 12%, transparent)', color: 'var(--bsp-down-text)' }}>
              <span className="material-symbols-outlined flex-shrink-0" aria-hidden="true" style={{ fontSize: '18px' }}>error</span>
              {t(error)}
            </p>
          )}

          {sso && signInStep && (
            <a href={sso.url} className={button} style={{ background: 'var(--bsp-action-bg)', color: 'var(--bsp-action-fg)' }}>
              <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '20px' }}>key</span>
              {sso.label}
            </a>
          )}
          {sso && passwordLogin && signInStep && (
            <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--bsp-text-muted)' }}>
              <span className="flex-1 h-px" style={hairline} />
              {t('signIn.or')}
              <span className="flex-1 h-px" style={hairline} />
            </div>
          )}

          {(passwordLogin || !signInStep) && (
            <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
              {settingPassword && (
                <>
                  <div>
                    <label htmlFor={`${ids}-new-password`} className={label} style={labelColor}>{t('signIn.newPassword')}</label>
                    <input
                      id={`${ids}-new-password`} type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} autoFocus
                      value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="bsp-input" style={input}
                    />
                  </div>
                  <div>
                    <label htmlFor={`${ids}-confirm-password`} className={label} style={labelColor}>{t('signIn.confirmPassword')}</label>
                    <input
                      id={`${ids}-confirm-password`} type="password" autoComplete="new-password" required
                      value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="bsp-input" style={input}
                    />
                  </div>
                </>
              )}

              {signInStep && (
                <>
                  <div>
                    <label htmlFor={`${ids}-email`} className={label} style={labelColor}>{t('signIn.email')}</label>
                    <input
                      id={`${ids}-email`} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)}
                      placeholder={t('signIn.emailPlaceholder')} className="bsp-input" style={input}
                    />
                  </div>
                  <div>
                    <label htmlFor={`${ids}-password`} className={label} style={labelColor}>{t('signIn.password')}</label>
                    <div className="relative">
                      <input
                        id={`${ids}-password`} type={showPassword ? 'text' : 'password'} autoComplete="current-password" required value={password}
                        onChange={(e) => setPassword(e.target.value)} className="bsp-input" style={{ ...input, paddingRight: '44px' }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((shown) => !shown)}
                        className="bsp-ghost absolute right-1 top-1 w-9 h-9 rounded-lg flex items-center justify-center"
                        style={{ color: 'var(--bsp-text-muted)' }}
                        aria-label={t(showPassword ? 'signIn.hidePassword' : 'signIn.showPassword')}
                        aria-pressed={showPassword}
                      >
                        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '20px' }}>{showPassword ? 'visibility_off' : 'visibility'}</span>
                      </button>
                    </div>
                  </div>
                </>
              )}

              {codeStep && (
                <div>
                  <label htmlFor={`${ids}-code`} className={label} style={labelColor}>{t('signIn.code')}</label>
                  <input
                    id={`${ids}-code`} type="text" autoComplete="one-time-code" required autoFocus value={code}
                    onChange={(e) => setCode(e.target.value)} placeholder={t('signIn.codePlaceholder')} className="bsp-input" style={input}
                  />
                  <button type="button" onClick={backToSignIn} className="text-xs mt-2 hover:underline" style={{ color: 'var(--bsp-text-muted)' }}>
                    {t('signIn.back')}
                  </button>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className={outlinedSubmit ? `${buttonBase} h-11 text-sm` : button}
                style={outlinedSubmit
                  ? { background: 'transparent', color: 'var(--bsp-text)', border: '1px solid var(--bsp-card-border)', opacity: loading ? 0.6 : 1 }
                  : { background: 'var(--bsp-action-bg)', color: 'var(--bsp-action-fg)', opacity: loading ? 0.6 : 1 }}
              >
                {loading ? t('signIn.submitting') : settingPassword ? t('signIn.setPasswordSubmit') : codeStep ? t('signIn.verify') : t('signIn.submit')}
              </button>
            </form>
          )}
        </div>
        {!settingPassword && <p className="text-[13px] text-center" style={{ color: 'var(--bsp-text-muted)' }}>{t('signIn.noAccess')}</p>}
      </main>
    </div>
  )
}
