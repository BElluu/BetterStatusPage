import { DEFAULT_ALERT_POLICY } from '@bsp/shared'
import type { ChannelAlertPolicy, QuietHoursPolicy } from '@bsp/shared'

const MINUTE_MS = 60_000
const DAY_MINUTES = 24 * 60
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

const formatters = new Map<string, Intl.DateTimeFormat>()

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

function formatter(timezone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timezone)
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    formatters.set(timezone, cached)
  }
  return cached
}

/** Minutes elapsed since local midnight in `timezone` at the given instant. */
export function localMinutes(at: number, timezone: string): number {
  const parts = formatter(isValidTimezone(timezone) ? timezone : 'UTC').formatToParts(new Date(at))
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0')
  return hour * 60 + minute
}

function timeToMinutes(value: string): number {
  const match = TIME_PATTERN.exec(value)
  if (!match) return 0
  return Number(match[1]) * 60 + Number(match[2])
}

/** True when `at` falls inside the channel's quiet window. Windows where end <= start wrap midnight. */
export function isWithinQuietHours(policy: QuietHoursPolicy, at: number): boolean {
  if (!policy.enabled) return false
  const start = timeToMinutes(policy.start)
  const end = timeToMinutes(policy.end)
  if (start === end) return false // zero-length window — nothing is ever quiet
  const now = localMinutes(at, policy.timezone)
  return start < end ? now >= start && now < end : now >= start || now < end
}

/** The instant the current quiet window ends. Only meaningful while `isWithinQuietHours` holds. */
export function quietHoursEndAt(policy: QuietHoursPolicy, at: number): number {
  const end = timeToMinutes(policy.end)
  const now = localMinutes(at, policy.timezone)
  const minutesAhead = (end - now + DAY_MINUTES) % DAY_MINUTES || DAY_MINUTES
  let candidate = at - (at % MINUTE_MS) + minutesAhead * MINUTE_MS
  // A DST shift inside the window moves the wall clock under us; nudge forward until it is over.
  for (let guard = 0; guard < 8 && isWithinQuietHours(policy, candidate); guard++) candidate += 30 * MINUTE_MS
  return candidate
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 0) return value === 1
  return fallback
}

function asInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function asTime(value: unknown, fallback: string): string {
  return typeof value === 'string' && TIME_PATTERN.test(value) ? value : fallback
}

/** Coerces untrusted input (API body or stored JSON) into a complete, in-range policy. */
export function normalizeAlertPolicy(input: unknown): ChannelAlertPolicy {
  const raw = asRecord(input)
  const quiet = asRecord(raw['quietHours'])
  const throttle = asRecord(raw['throttle'])
  const grouping = asRecord(raw['grouping'])
  const timezone = typeof quiet['timezone'] === 'string' && isValidTimezone(quiet['timezone'])
    ? quiet['timezone']
    : DEFAULT_ALERT_POLICY.quietHours.timezone

  return {
    quietHours: {
      enabled: asBool(quiet['enabled'], DEFAULT_ALERT_POLICY.quietHours.enabled),
      start: asTime(quiet['start'], DEFAULT_ALERT_POLICY.quietHours.start),
      end: asTime(quiet['end'], DEFAULT_ALERT_POLICY.quietHours.end),
      timezone,
      mode: quiet['mode'] === 'suppress' ? 'suppress' : 'defer',
    },
    throttle: {
      enabled: asBool(throttle['enabled'], DEFAULT_ALERT_POLICY.throttle.enabled),
      maxAlerts: asInt(throttle['maxAlerts'], 1, 100, DEFAULT_ALERT_POLICY.throttle.maxAlerts),
      windowMinutes: asInt(throttle['windowMinutes'], 1, 1440, DEFAULT_ALERT_POLICY.throttle.windowMinutes),
    },
    grouping: {
      enabled: asBool(grouping['enabled'], DEFAULT_ALERT_POLICY.grouping.enabled),
      minMonitors: asInt(grouping['minMonitors'], 2, 100, DEFAULT_ALERT_POLICY.grouping.minMonitors),
      windowSeconds: asInt(grouping['windowSeconds'], 10, 900, DEFAULT_ALERT_POLICY.grouping.windowSeconds),
    },
  }
}

/** Reads a channel's stored `alert_policy` column, falling back to defaults on anything unusable. */
export function parseAlertPolicy(stored: string | null | undefined): ChannelAlertPolicy {
  if (!stored) return normalizeAlertPolicy({})
  try {
    return normalizeAlertPolicy(JSON.parse(stored))
  } catch {
    return normalizeAlertPolicy({})
  }
}
