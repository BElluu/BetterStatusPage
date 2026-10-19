import { and, gte, lte, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { maintenanceWindows } from '../db/schema.js'
import { isValidTimezone } from './alertPolicy.js'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** How far past the longest possible gap between two occurrences (a weekly window with one day) a scan looks. */
const SCAN_DAYS = 8

export interface ScheduledWindow {
  startsAt: number
  endsAt: number
  recurrence: string
  /** Comma-separated weekdays (0 = Sunday), used by `weekly`. */
  recurrenceDays: string | null
  timezone: string
  /** Last instant a recurring window may start; null = no end. */
  recurrenceUntil: number | null
  /** Start of the occurrence that was ended early, and when; that occurrence stops at the later time. */
  endedEarlyStart: number | null
  endedEarlyAt: number | null
}

export interface Occurrence { startsAt: number; endsAt: number }

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timezone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timezone)
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone: isValidTimezone(timezone) ? timezone : 'UTC', hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    })
    formatters.set(timezone, cached)
  }
  return cached
}

/** The local calendar date (as UTC midnight of that date), the minutes since local midnight, and the UTC offset at `at`. */
function localParts(at: number, timezone: string) {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(new Date(at)).map((part) => [part.type, Number(part.value)]))
  const wall = Date.UTC(parts['year']!, parts['month']! - 1, parts['day']!, parts['hour']!, parts['minute']!, parts['second']!)
  return {
    day: Date.UTC(parts['year']!, parts['month']! - 1, parts['day']!),
    minutes: parts['hour']! * 60 + parts['minute']!,
    offset: wall - (at - (((at % 1000) + 1000) % 1000)),
  }
}

/** The instant at which the wall clock of `timezone` reads `minutes` on the local date `day` (UTC midnight of it). */
function instantOf(day: number, minutes: number, timezone: string): number {
  const wall = day + minutes * MINUTE_MS
  const guess = wall - localParts(wall, timezone).offset
  return wall - localParts(guess, timezone).offset
}

export function parseRecurrenceDays(value: string | null): number[] {
  return (value ?? '').split(',').map((part) => part.trim()).filter(Boolean).map(Number)
}

/**
 * The longest an occurrence may be so that it ends before the next one starts, also on a local day of 23 hours:
 * an hour less than a day for `daily`, and than the shortest gap between two chosen weekdays for `weekly`.
 * Longer ones would overlap, and ending one early could not stop both.
 */
export function maxOccurrenceMs(recurrence: string, weekdays: number[]): number {
  if (recurrence === 'daily') return DAY_MS - HOUR_MS
  if (recurrence !== 'weekly') return Infinity
  const days = [...new Set(weekdays)].sort((a, b) => a - b)
  if (days.length === 0) return Infinity
  let gap = 7
  for (let i = 0; i < days.length; i++) {
    const next = i + 1 < days.length ? days[i + 1]! : days[0]! + 7
    if (days.length > 1) gap = Math.min(gap, next - days[i]!)
  }
  return gap * DAY_MS - HOUR_MS
}

/**
 * The occurrence of the window running at `now` (`current`) and the first one that starts after it (`next`; left
 * out, and not searched for, when `untilNow` is set). A one-off window has exactly its own span. Occurrences are
 * built from local calendar dates, so a change of clocks neither skips nor repeats a day. A weekly window starts
 * on the first chosen weekday on or after its own start.
 */
export function windowOccurrences(win: ScheduledWindow, now: number, untilNow = false): { current: Occurrence | null; next: Occurrence | null } {
  const own = { startsAt: win.startsAt, endsAt: win.endsAt }
  if (win.recurrence === 'none') {
    return { current: own.startsAt <= now && own.endsAt >= now ? own : null, next: own.startsAt > now ? own : null }
  }
  const timezone = win.timezone
  const length = win.endsAt - win.startsAt
  const first = localParts(win.startsAt, timezone)
  const startMinutes = first.minutes
  const subMinute = ((win.startsAt % MINUTE_MS) + MINUTE_MS) % MINUTE_MS
  const weekdays = parseRecurrenceDays(win.recurrenceDays)
  // An occurrence that is running began no earlier than `length` ago, so its local date is not before this one;
  // and none starts before the window itself, which can be far ahead.
  const firstDay = Math.max(localParts(now - length, timezone).day, first.day)
  const days = Math.ceil(length / DAY_MS) + SCAN_DAYS
  let current: Occurrence | null = null
  let next: Occurrence | null = null
  for (let i = 0; i <= days && !next; i++) {
    const day = firstDay + i * DAY_MS
    if (win.recurrence === 'weekly' && !weekdays.includes(new Date(day).getUTCDay())) continue
    // On the day of the window's own start the stored instant is the occurrence, whichever of two equal local times it is.
    const startsAt = day === first.day ? win.startsAt : instantOf(day, startMinutes, timezone) + subMinute
    if (startsAt < win.startsAt) continue
    if (win.recurrenceUntil !== null && startsAt > win.recurrenceUntil) break
    if (untilNow && startsAt > now) break
    const endsAt = startsAt + length
    const occurrence = { startsAt, endsAt: startsAt === win.endedEarlyStart ? Math.min(endsAt, win.endedEarlyAt ?? endsAt) : endsAt }
    if (startsAt > now) next = occurrence
    else if (occurrence.endsAt >= now) current = occurrence
  }
  return { current, next }
}

/** The occurrence a window is currently showing: the one running, else the next one, else its own span. */
export function shownOccurrence(win: ScheduledWindow, now: number): Occurrence {
  const { current, next } = windowOccurrences(win, now)
  return current ?? next ?? { startsAt: win.startsAt, endsAt: win.endsAt }
}

/**
 * Windows running or still to come at `now`, each with the span of the occurrence it shows. A window whose
 * last occurrence is over is left out.
 */
export async function liveWindows(now: number) {
  const length = sql`${maintenanceWindows.endsAt} - ${maintenanceWindows.startsAt}`
  const rows = await db.select().from(maintenanceWindows).where(
    or(
      gte(maintenanceWindows.endsAt, now),
      and(
        ne(maintenanceWindows.recurrence, 'none'),
        or(sql`${maintenanceWindows.recurrenceUntil} is null`, sql`${maintenanceWindows.recurrenceUntil} + ${length} >= ${now}`),
      ),
    ),
  )
  return rows.flatMap((win) => {
    const { current, next } = windowOccurrences(win, now)
    const shown = current ?? next
    return shown ? [{ ...win, ...shown }] : []
  })
}

/** Windows running at `now`, each with the span of the running occurrence. Runs for every check, so it looks no further. */
export async function activeWindows(now: number) {
  const length = sql`${maintenanceWindows.endsAt} - ${maintenanceWindows.startsAt}`
  const rows = await db.select().from(maintenanceWindows).where(
    and(
      lte(maintenanceWindows.startsAt, now),
      or(
        gte(maintenanceWindows.endsAt, now),
        and(
          ne(maintenanceWindows.recurrence, 'none'),
          or(sql`${maintenanceWindows.recurrenceUntil} is null`, sql`${maintenanceWindows.recurrenceUntil} + ${length} >= ${now}`),
        ),
      ),
    ),
  )
  return rows.flatMap((win) => {
    const { current } = windowOccurrences(win, now, true)
    return current ? [{ ...win, ...current }] : []
  })
}
