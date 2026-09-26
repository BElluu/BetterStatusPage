import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDarkMode } from './useDarkMode'

function prefersDark(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches })))
}

describe('status page useDarkMode', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    vi.unstubAllGlobals()
  })

  it('starts from the system preference', () => {
    prefersDark(true)
    const { result } = renderHook(() => useDarkMode())
    expect(result.current[0]).toBe(true)
    expect(document.documentElement).toHaveClass('dark')
  })

  it('remembers the visitor choice across visits', () => {
    prefersDark(false)
    const first = renderHook(() => useDarkMode())
    act(() => first.result.current[1]())
    expect(localStorage.getItem('bsp-dark-mode')).toBe('true')
    first.unmount()

    prefersDark(false)
    const next = renderHook(() => useDarkMode())
    expect(next.result.current[0]).toBe(true)
    act(() => next.result.current[1]())
    expect(document.documentElement).not.toHaveClass('dark')
    expect(localStorage.getItem('bsp-dark-mode')).toBe('false')
  })
})
