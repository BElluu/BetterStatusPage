import { useState, useEffect } from 'react'
import { safeLocalStorage } from '@better-kit/contracts'

// Mirrors packages/ui's useDarkMode with this app's fixed storage keys; the public app does not depend on @better-kit/ui.

export function useDarkMode(): [boolean, () => void] {
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === 'undefined') return false
    const stored = safeLocalStorage.get('bsp-dark-mode')
    if (stored !== null) return stored === 'true'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    const html = document.documentElement
    if (isDark) {
      html.classList.add('dark')
    } else {
      html.classList.remove('dark')
    }
    safeLocalStorage.set('bsp-dark-mode', String(isDark))
    // Every mounted instance (e.g. the sidebar toggle and a page that swaps its logo) listens for this, so one toggle
    // updates them all.
    window.dispatchEvent(new CustomEvent('bsp-dark-mode-change', { detail: isDark }))
  }, [isDark])

  useEffect(() => {
    const handler = (e: Event) => {
      const dark = (e as CustomEvent<boolean>).detail
      setIsDark(dark)
    }
    window.addEventListener('bsp-dark-mode-change', handler)
    return () => window.removeEventListener('bsp-dark-mode-change', handler)
  }, [])

  return [isDark, () => setIsDark((d) => !d)]
}
