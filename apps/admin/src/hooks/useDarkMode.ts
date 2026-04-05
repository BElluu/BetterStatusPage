import { useState, useEffect } from 'react'

export function useDarkMode(): [boolean, () => void] {
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === 'undefined') return false
    const stored = localStorage.getItem('bsp-dark-mode')
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
    localStorage.setItem('bsp-dark-mode', String(isDark))
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
