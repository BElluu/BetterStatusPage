export const DEFAULT_BRANDING_COLORS = {
  primaryColor: '#000000',
  accentColor: '#497cff',
  backgroundColor: '#faf8ff',
  cardBackground: '#f2f3ff',
  elevatedBackground: '#e2e7ff',
  chartBackground: '#f2f3ff',
  cardBorderColor: '#c6c6cd',
  chartGridColor: '#c6c6cd',
  textColor: '#131b2e',
  textMutedColor: '#505f76',
  statusUpColor: '#22c55e',
  statusDownColor: '#ba1a1a',
  statusDegradedColor: '#eab308',
  statusPartialColor: '#f97316',
} as const

/**
 * Minimum daily uptime (in %) for a day of the uptime bar to be shown in each colour; anything
 * below `partial` is a major outage. Global for the whole status page, like Statuspage's calculation.
 */
export const DEFAULT_UPTIME_THRESHOLDS = {
  uptimeThresholdUp: 99.9,
  uptimeThresholdDegraded: 99,
  uptimeThresholdPartial: 95,
} as const

export type UptimeThresholds = { [K in keyof typeof DEFAULT_UPTIME_THRESHOLDS]: number }

export type UptimeDayStatus = 'up' | 'degraded' | 'partial' | 'down' | 'no-data'

/** Colour class of one day of the uptime bar; `null` means the day has no checks. */
export function classifyUptimeDay(uptimePct: number | null, thresholds: UptimeThresholds): UptimeDayStatus {
  if (uptimePct === null) return 'no-data'
  if (uptimePct >= thresholds.uptimeThresholdUp) return 'up'
  if (uptimePct >= thresholds.uptimeThresholdDegraded) return 'degraded'
  if (uptimePct >= thresholds.uptimeThresholdPartial) return 'partial'
  return 'down'
}

/** Returns an error message, or null when the thresholds are within 0–100 and strictly descending. */
export function validateUptimeThresholds(thresholds: UptimeThresholds): string | null {
  const values = [thresholds.uptimeThresholdUp, thresholds.uptimeThresholdDegraded, thresholds.uptimeThresholdPartial]
  if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100)) {
    return 'Uptime thresholds must be numbers between 0 and 100'
  }
  if (!(values[0]! > values[1]! && values[1]! > values[2]!)) {
    return 'Uptime thresholds must be descending: up > degraded > partial'
  }
  return null
}

export interface Branding {
  id: number
  siteName: string
  logoUrl: string | null
  logoLightUrl: string | null
  logoDarkUrl: string | null
  faviconUrl: string | null
  primaryColor: string
  accentColor: string
  backgroundColor: string
  cardBackground: string
  cardBorderColor: string
  textColor: string
  textMutedColor: string
  statusUpColor: string
  statusDownColor: string
  statusDegradedColor: string
  statusPartialColor: string
  uptimeThresholdUp: number
  uptimeThresholdDegraded: number
  uptimeThresholdPartial: number
  elevatedBackground: string
  chartBackground: string
  chartGridColor: string
  customCss: string | null
  enabled: number
  /** 1 shows the status headline above the page content; 0 hides it to leave more room for monitors. */
  showHero: number
  logoType: string
  logoText: string | null
  updatedAt: number
}
