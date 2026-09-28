import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Returns `value` once it has stopped changing for `delay` ms, plus a `flush` that applies it immediately
 * (e.g. on Enter) or sets an explicit value (e.g. clearing a search box).
 */
export function useDebouncedValue<T>(value: T, delay = 300): [T, (next?: T) => void] {
  const [debounced, setDebounced] = useState(value)
  const latest = useRef(value)

  useEffect(() => {
    latest.current = value
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  const flush = useCallback((next?: T) => {
    setDebounced(next === undefined ? latest.current : next)
  }, [])

  return [debounced, flush]
}
