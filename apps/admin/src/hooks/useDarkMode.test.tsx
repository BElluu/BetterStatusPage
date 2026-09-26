import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDarkMode } from './useDarkMode'

function prefersDark(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches })))
}

describe('admin useDarkMode', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    vi.unstubAllGlobals()
  })

  it('follows the system preference until the user chooses', () => {
    prefersDark(true)
    const { result } = renderHook(() => useDarkMode())
    expect(result.current[0]).toBe(true)
    expect(document.documentElement).toHaveClass('dark')
    expect(localStorage.getItem('bsp-dark-mode')).toBe('true')
  })

  it('prefers the stored choice over the system preference', () => {
    prefersDark(true)
    localStorage.setItem('bsp-dark-mode', 'false')
    const { result } = renderHook(() => useDarkMode())
    expect(result.current[0]).toBe(false)
    expect(document.documentElement).not.toHaveClass('dark')
  })

  it('persists a toggle and keeps every mounted toggle in sync', () => {
    prefersDark(false)
    const sidebar = renderHook(() => useDarkMode())
    const header = renderHook(() => useDarkMode())

    act(() => sidebar.result.current[1]())

    expect(sidebar.result.current[0]).toBe(true)
    expect(header.result.current[0]).toBe(true)
    expect(localStorage.getItem('bsp-dark-mode')).toBe('true')
    expect(document.documentElement).toHaveClass('dark')
  })
})
