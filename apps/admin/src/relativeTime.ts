import { useEffect, useState } from 'react'

/** "8 s ago", "5 min ago", "3 h ago", "2 d ago"; a moment in the future reads as "just now". */
export function formatAgo(timestamp: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - timestamp) / 1000))
  if (secs < 5) return 'just now'
  if (secs < 60) return `${secs} s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

/** How long something has lasted: "<1 min", "14 min", "2 h 5 min", "3 d". */
export function formatSpan(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60_000)
  if (mins < 1) return '<1 min'
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return mins % 60 ? `${hours} h ${mins % 60} min` : `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

/** The current time, refreshed on an interval so relative times keep counting while the page stays open. */
export function useNow(intervalMs = 5_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
