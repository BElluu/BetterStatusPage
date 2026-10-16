import { useEffect, useState, type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { api, clearSession, getCurrentUser, mustChangePassword, setSession, type AuthUser } from '../api/client'
import { uiConfig } from '../config'
import { navigation } from '../navigation'

/** Sends a first visit to the setup page, while the application has no administrator yet. */
export function SetupGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'setup' | 'ready'>('loading')

  useEffect(() => {
    fetch(`${uiConfig().apiBase}/setup/status`)
      .then((r) => r.json())
      .then((data: { needsSetup: boolean }) => {
        setState(data.needsSetup ? 'setup' : 'ready')
      })
      .catch(() => setState('ready'))
  }, [])

  if (state === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--m3-surface)' }}>
        <div className="flex flex-col items-center gap-4">
          <div
            className="w-10 h-10 rounded-2xl flex items-center justify-center"
            style={{ background: 'var(--m3-primary-fixed)' }}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <circle cx="10" cy="10" r="3.5" fill="var(--m3-primary)" />
              <circle cx="10" cy="10" r="8.5" stroke="var(--m3-primary)" strokeWidth="1.2" strokeOpacity="0.35" fill="none" />
            </svg>
          </div>
          <span className="font-sans text-sm" style={{ color: 'var(--m3-secondary)' }}>Starting…</span>
        </div>
      </div>
    )
  }

  if (state === 'setup') return <Navigate to={`${uiConfig().basePath}/setup`} replace />
  return <>{children}</>
}

/**
 * Renders its children for a signed-in user. Someone who is not signed in goes to the sign-in page; someone the
 * application sends elsewhere (`redirectAfterSignIn`) leaves the interface for that address.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'authenticated' | 'anonymous' | 'elsewhere'>('checking')
  const [elsewhere, setElsewhere] = useState<string | null>(null)

  useEffect(() => {
    api.get<AuthUser>('/auth/session')
      .then((user) => {
        setSession(user)
        const target = uiConfig().redirectAfterSignIn?.(user) ?? null
        setElsewhere(target)
        setState(target ? 'elsewhere' : 'authenticated')
      })
      .catch(() => { clearSession(); setState('anonymous') })
  }, [])

  useEffect(() => {
    if (state === 'elsewhere' && elsewhere) navigation.assign(elsewhere)
  }, [state, elsewhere])

  if (state === 'checking' || state === 'elsewhere') return null
  if (state === 'anonymous') return <Navigate to={`${uiConfig().basePath}/login`} replace />
  return <>{children}</>
}

/** Keeps a user who has to replace a temporary password on the page where they do it. */
export function RequirePasswordChanged({ children }: { children: ReactNode }) {
  if (mustChangePassword()) return <Navigate to={`${uiConfig().basePath}/change-password`} replace />
  return <>{children}</>
}

/**
 * A guard for pages that need a role: a user whose rank is below the page's goes to the home page of their role.
 * `roleRank` lists the roles by rank (higher sees more); a role it does not know ranks lowest.
 */
export function createRoleGuard(options: { roleRank: Readonly<Record<string, number>>; homeOf: (role?: string) => string }) {
  return function RequireRole({ minRole, children }: { minRole: string; children: ReactNode }) {
    const user = getCurrentUser()
    const rank = options.roleRank[user?.role ?? ''] ?? 0
    if (rank < (options.roleRank[minRole] ?? 99)) return <Navigate to={options.homeOf(user?.role)} replace />
    return <>{children}</>
  }
}
