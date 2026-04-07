import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import type { TranslationKey, LocaleSummary } from '@bsp/shared'
import { EN_DEFAULTS } from './defaults'

const LS_KEY = 'bsp-locale'

type TFn = (key: TranslationKey, params?: Record<string, string | number>) => string

interface LocaleCtx {
  locale: string
  availableLocales: LocaleSummary[]
  t: TFn
  setLocale: (code: string) => void
}

const Context = createContext<LocaleCtx>({
  locale: 'en',
  availableLocales: [],
  t: (key) => EN_DEFAULTS[key] ?? key,
  setLocale: () => {},
})

export function useLocale() {
  return useContext(Context)
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [availableLocales, setAvailableLocales] = useState<LocaleSummary[]>([])
  const [locale, setLocaleState] = useState<string>(() => localStorage.getItem(LS_KEY) ?? 'en')
  const [translations, setTranslations] = useState<Partial<Record<TranslationKey, string>>>({})

  // Fetch list of available locales; determine active locale if not yet set
  useEffect(() => {
    fetch('/api/v1/public/locales')
      .then((r) => r.json())
      .then((data: LocaleSummary[]) => {
        if (!Array.isArray(data) || data.length === 0) return
        setAvailableLocales(data)

        const saved = localStorage.getItem(LS_KEY)
        if (saved && data.find((l) => l.code === saved)) {
          // User previously chose a language — keep it
          return
        }
        // No saved preference: use the locale marked as default, fallback to 'en'
        const defaultLocale = data.find((l) => l.isDefault === 1) ?? data.find((l) => l.code === 'en') ?? data[0]!
        setLocaleState(defaultLocale.code)
      })
      .catch(() => {})
  }, [])

  // Fetch translations whenever active locale changes
  useEffect(() => {
    if (!locale || locale === 'en') {
      setTranslations({})
      return
    }
    fetch(`/api/v1/public/locales/${locale}`)
      .then((r) => r.json())
      .then((data: { translations: Partial<Record<TranslationKey, string>> }) => {
        setTranslations(data.translations ?? {})
      })
      .catch(() => setTranslations({}))
  }, [locale])

  const setLocale = useCallback((code: string) => {
    localStorage.setItem(LS_KEY, code)
    setLocaleState(code)
  }, [])

  const t: TFn = useCallback((key, params) => {
    let value = translations[key] ?? EN_DEFAULTS[key] ?? key
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        value = value.replace(`{${k}}`, String(v))
      }
    }
    return value
  }, [translations])

  return (
    <Context.Provider value={{ locale, availableLocales, t, setLocale }}>
      {children}
    </Context.Provider>
  )
}
