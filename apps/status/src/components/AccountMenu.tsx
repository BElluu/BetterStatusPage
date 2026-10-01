import { useEffect, useId, useRef, useState } from 'react'
import { postJSON } from '../api'
import { useLocale } from '../i18n/LocaleContext'
import { adminUrl, navigation } from '../navigation'

const ITEM = 'bsp-ghost flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg text-sm'

/**
 * Who is signed in to a private status page, and signing out. Everyone but a viewer also gets a link to the admin
 * console; a viewer has nothing to do there.
 */
export function AccountMenu({ email, role }: { email: string; role: string | null }) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', onClickOutside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClickOutside)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function signOut() {
    setSigningOut(true)
    try { await postJSON('/api/v1/auth/logout') } catch { /* the page reloads to the sign-in screen either way */ }
    // A full reload drops everything this session loaded.
    navigation.assign('/')
  }

  return (
    <div
      ref={ref}
      style={{ position: 'relative' }}
      onBlur={(e) => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false) }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="bsp-ghost p-2 rounded-full transition-all active:scale-95"
        style={{ color: 'var(--m3-secondary)' }}
        aria-label={t('signIn.account')}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '22px' }}>account_circle</span>
      </button>

      {open && (
        <div
          id={menuId}
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            minWidth: '220px',
            background: 'var(--m3-surface-container-high)',
            border: '1px solid var(--m3-outline-variant)',
            borderRadius: '12px',
            padding: '6px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            zIndex: 100,
          }}
        >
          <p className="px-3 py-2 text-xs break-all" style={{ color: 'var(--m3-secondary)' }}>{t('signIn.signedInAs', { email })}</p>
          {role !== 'viewer' && (
            <a href={adminUrl('/')} className={ITEM} style={{ color: 'var(--m3-on-surface)' }}>
              <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>dashboard</span>
              {t('signIn.adminConsole')}
            </a>
          )}
          <button type="button" disabled={signingOut} onClick={() => void signOut()} className={ITEM} style={{ color: 'var(--m3-on-surface)' }}>
            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>logout</span>
            {t('signIn.signOut')}
          </button>
        </div>
      )}
    </div>
  )
}
