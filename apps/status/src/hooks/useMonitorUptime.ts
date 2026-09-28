import { useEffect, useState } from 'react'
import type { UptimeDayStatus } from '@bsp/shared'
import { getJSON } from '../api'

export interface UptimeDay {
  date: string
  status: UptimeDayStatus
  uptimePct: number
  incidents?: Array<{ id: number; title: string; durationMs: number | null }>
}

export interface MonitorUptime {
  days: UptimeDay[]
  overallUptimePct: number | null
}

export interface MonitorUptimeState {
  /** Null until it has loaded, and when the request failed. */
  uptime: MonitorUptime | null
  failed: boolean
}

/**
 * Daily uptime of one monitor over the last `days` days.
 * A response for an earlier monitor/range is ignored, so a slow request can never overwrite newer data.
 */
export function useMonitorUptime(monitorId: number, days: number): MonitorUptimeState {
  const key = `${monitorId}:${days}`
  const [result, setResult] = useState<{ key: string; uptime: MonitorUptime | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    const requestKey = `${monitorId}:${days}`
    getJSON<MonitorUptime>(`/api/v1/public/monitor/${monitorId}/uptime?days=${days}`)
      .then((uptime) => { if (!cancelled) setResult({ key: requestKey, uptime }) })
      .catch(() => { if (!cancelled) setResult({ key: requestKey, uptime: null }) })
    return () => { cancelled = true }
  }, [monitorId, days])

  const current = result?.key === key ? result : null
  return { uptime: current?.uptime ?? null, failed: !!current && current.uptime === null }
}
