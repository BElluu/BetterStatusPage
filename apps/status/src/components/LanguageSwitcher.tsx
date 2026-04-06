import { useState, useRef, useEffect } from 'react'
import { useLocale } from '../i18n/LocaleContext'

export function LanguageSwitcher() {
  const { locale, availableLocales, setLocale } = useLocale()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  if (availableLocales.length <= 1) return null

  const current = availableLocales.find((l) => l.code === locale)

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-all active:scale-95"
        style={{ color: 'var(--m3-secondary)', background: open ? 'var(--m3-surface-container)' : 'transparent' }}
        onMouseEnter={(e) => { (e.currentTarget).style.background = 'var(--m3-surface-container)' }}
        onMouseLeave={(e) => { if (!open) (e.currentTarget).style.background = 'transparent' }}
        aria-label="Change language"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>language</span>
        <span className="text-sm font-semibold uppercase tracking-wide">{current?.code ?? locale}</span>
      </button>

      {open && (
        <div
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
          {availableLocales.map((l) => (
            <button
              key={l.code}
              onClick={() => { setLocale(l.code); setOpen(false) }}
              className="w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                color: l.code === locale ? 'var(--m3-on-surface)' : 'var(--m3-secondary)',
                background: l.code === locale ? 'var(--m3-surface-container-highest)' : 'transparent',
                fontWeight: l.code === locale ? 700 : 500,
              }}
              onMouseEnter={(e) => {
                if (l.code !== locale) (e.currentTarget).style.background = 'var(--m3-surface-container)'
              }}
              onMouseLeave={(e) => {
                if (l.code !== locale) (e.currentTarget).style.background = 'transparent'
              }}
            >
              {l.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
