import { useState, useRef, useEffect, useId } from 'react'
import { useLocale } from '../i18n/LocaleContext'

export function LanguageSwitcher() {
  const { t, locale, availableLocales, setLocale } = useLocale()
  const [open, setOpen] = useState(false)
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

  if (availableLocales.length <= 1) return null

  const current = availableLocales.find((l) => l.code === locale)

  return (
    <div
      ref={ref}
      style={{ position: 'relative' }}
      // Tabbing out of the switcher closes the menu, like clicking elsewhere does. A blur without a new
      // focus target (Safari does not focus clicked buttons) is left to the outside-click handler.
      onBlur={(e) => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false) }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="bsp-ghost flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-all active:scale-95"
        style={{ color: 'var(--m3-secondary)' }}
        aria-label={t('page.changeLanguage')}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '20px' }}>language</span>
        <span className="text-sm font-semibold uppercase tracking-wide">{current?.code ?? locale}</span>
      </button>

      {open && (
        <div
          id={menuId}
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            minWidth: '140px',
            background: 'var(--m3-surface-container-high)',
            border: '1px solid var(--m3-outline-variant)',
            borderRadius: '12px',
            padding: '6px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            zIndex: 100,
          }}
        >
          {availableLocales.map((l) => {
            const active = l.code === locale
            return (
              <button
                key={l.code}
                type="button"
                lang={l.code}
                aria-current={active ? 'true' : undefined}
                onClick={() => { setLocale(l.code); setOpen(false); triggerRef.current?.focus() }}
                className="bsp-ghost w-full text-left px-3 py-2 rounded-lg text-sm"
                style={{
                  color: active ? 'var(--m3-on-surface)' : 'var(--m3-secondary)',
                  background: active ? 'var(--m3-surface-container-highest)' : undefined,
                  fontWeight: active ? 700 : 500,
                }}
              >
                {l.name}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
