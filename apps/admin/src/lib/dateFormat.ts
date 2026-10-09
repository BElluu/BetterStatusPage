import { useSyncExternalStore } from 'react'

/** Admin date and time display, chosen per browser in Settings. */
export type DateFormat = 'dmy' | 'dmyDash' | 'mdy' | 'ymd' | 'ymdDot'
export type TimeFormat = '24h' | '12h'
export interface DatePrefs { date: DateFormat; time: TimeFormat }

interface DatePattern { label: string; full: (y: number, m: string, d: string) => string; dayMonth: (m: string, d: string) => string }

const DATE_PATTERNS: Record<DateFormat, DatePattern> = {
  dmy: { label: 'dd.mm.yyyy', full: (y, m, d) => `${d}.${m}.${y}`, dayMonth: (m, d) => `${d}.${m}` },
  dmyDash: { label: 'dd-mm-yyyy', full: (y, m, d) => `${d}-${m}-${y}`, dayMonth: (m, d) => `${d}-${m}` },
  mdy: { label: 'mm/dd/yyyy', full: (y, m, d) => `${m}/${d}/${y}`, dayMonth: (m, d) => `${m}/${d}` },
  ymd: { label: 'yyyy-mm-dd', full: (y, m, d) => `${y}-${m}-${d}`, dayMonth: (m, d) => `${m}-${d}` },
  ymdDot: { label: 'yyyy.mm.dd', full: (y, m, d) => `${y}.${m}.${d}`, dayMonth: (m, d) => `${m}.${d}` },
}

export const DATE_FORMATS = (Object.keys(DATE_PATTERNS) as DateFormat[]).map((value) => ({ value, label: DATE_PATTERNS[value].label }))
export const TIME_FORMATS: ReadonlyArray<{ value: TimeFormat; label: string }> = [
  { value: '24h', label: '24-hour' },
  { value: '12h', label: '12-hour' },
]

const STORAGE_KEY = 'bsp-date-format'
const DEFAULTS: DatePrefs = { date: 'dmy', time: '24h' }

function load(): DatePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<DatePrefs> | null
    return {
      date: DATE_FORMATS.some((f) => f.value === raw?.date) ? raw!.date! : DEFAULTS.date,
      time: TIME_FORMATS.some((f) => f.value === raw?.time) ? raw!.time! : DEFAULTS.time,
    }
  } catch {
    return DEFAULTS
  }
}

let prefs = load()
const listeners = new Set<() => void>()

export function getDatePrefs(): DatePrefs { return prefs }

export function setDatePrefs(next: DatePrefs): void {
  prefs = next
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* storage unavailable: applies to this tab only */ }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useDatePrefs(): DatePrefs {
  return useSyncExternalStore(subscribe, getDatePrefs)
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** `utc` formats the UTC calendar day instead of the local one (for UTC-bucketed data). */
export function formatDate(ms: number, utc = false): string {
  const d = new Date(ms)
  return DATE_PATTERNS[prefs.date].full(
    utc ? d.getUTCFullYear() : d.getFullYear(),
    pad((utc ? d.getUTCMonth() : d.getMonth()) + 1),
    pad(utc ? d.getUTCDate() : d.getDate()),
  )
}

export function formatDayMonth(ms: number): string {
  const d = new Date(ms)
  return DATE_PATTERNS[prefs.date].dayMonth(pad(d.getMonth() + 1), pad(d.getDate()))
}

export function formatClock(ms: number, seconds = false): string {
  const d = new Date(ms)
  const mm = pad(d.getMinutes())
  const ss = seconds ? `:${pad(d.getSeconds())}` : ''
  if (prefs.time === '12h') {
    const h = d.getHours()
    return `${h % 12 || 12}:${mm}${ss} ${h < 12 ? 'AM' : 'PM'}`
  }
  return `${pad(d.getHours())}:${mm}${ss}`
}

export function formatDateTime(ms: number, seconds = false): string {
  return `${formatDate(ms)} ${formatClock(ms, seconds)}`
}
