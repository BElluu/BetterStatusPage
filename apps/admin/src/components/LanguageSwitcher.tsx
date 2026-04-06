import { useAdminLocale } from '../i18n/LocaleContext'

export function AdminLanguageSwitcher() {
  const { locale, availableLocales, setLocale } = useAdminLocale()

  if (availableLocales.length <= 1) return null

  return (
    <div
      className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm transition-all hover:translate-x-1"
      style={{ color: 'var(--m3-secondary)' }}
      onMouseEnter={(e) => {
        ;(e.currentTarget).style.background = 'rgba(0,0,0,0.04)'
        ;(e.currentTarget).style.color = 'var(--m3-on-surface)'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget).style.background = ''
        ;(e.currentTarget).style.color = 'var(--m3-secondary)'
      }}
    >
      <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: '20px' }}>language</span>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value)}
        className="flex-1 bg-transparent border-none outline-none cursor-pointer font-sans text-sm"
        style={{ color: 'inherit' }}
        onClick={(e) => e.stopPropagation()}
      >
        {availableLocales.map((l) => (
          <option key={l.code} value={l.code}>{l.name}</option>
        ))}
      </select>
    </div>
  )
}
