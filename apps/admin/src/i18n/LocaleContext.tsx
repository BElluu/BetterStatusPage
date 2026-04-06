import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import type { AdminTranslationKey, LocaleSummary } from '@bsp/shared'
import { EN_ADMIN_DEFAULTS } from './defaults'
import { api } from '../api/client'

const LS_KEY = 'bsp-admin-locale'

type TFn = (key: AdminTranslationKey) => string

interface AdminLocaleCtx {
  locale: string
  availableLocales: LocaleSummary[]
  t: TFn
  setLocale: (code: string) => void
}

const Context = createContext<AdminLocaleCtx>({
  locale: 'en',
  availableLocales: [],
  t: (key) => EN_ADMIN_DEFAULTS[key] ?? key,
  setLocale: () => {},
})

export function useAdminLocale() {
  return useContext(Context)
}

export function AdminLocaleProvider({ children }: { children: ReactNode }) {
  const [availableLocales, setAvailableLocales] = useState<LocaleSummary[]>([])
  const [locale, setLocaleState] = useState<string>(() => localStorage.getItem(LS_KEY) ?? 'en')
  const [translations, setTranslations] = useState<Partial<Record<AdminTranslationKey, string>>>({})

  useEffect(() => {
    api.get<Array<{ code: string; name: string; adminTranslations: Record<AdminTranslationKey, string> }>>('/admin/locales')
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          setAvailableLocales(data.map((l) => ({ code: l.code, name: l.name })))
          const saved = localStorage.getItem(LS_KEY)
          const target = data.find((l) => l.code === (saved ?? 'en')) ?? data[0]!
          setLocaleState(target.code)
          setTranslations(target.adminTranslations ?? {})
        }
      })
      .catch(() => {})
  }, [])

  const setLocale = useCallback((code: string) => {
    localStorage.setItem(LS_KEY, code)
    setLocaleState(code)
    // Re-fetch translations for the new locale
    api.get<{ adminTranslations: Record<AdminTranslationKey, string> }>(`/admin/locales/${code}`)
      .then((data) => setTranslations(data.adminTranslations ?? {}))
      .catch(() => setTranslations({}))
  }, [])

  const t: TFn = useCallback((key) => {
    return translations[key] ?? EN_ADMIN_DEFAULTS[key] ?? key
  }, [translations])

  return (
    <Context.Provider value={{ locale, availableLocales, t, setLocale }}>
      {children}
    </Context.Provider>
  )
}
