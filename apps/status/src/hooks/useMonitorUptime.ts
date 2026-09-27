import { useEffect, useState } from 'react'
import { getJSON } from '../api'

export interface UptimeDay {
  date: string
  status: string
  uptimePct: number
  incidents?: Array<{ id: number; title: string; durationMs: number | null }>
}

export interface MonitorUptime {
  days: UptimeDay[]
  overallUptimePct: number | null
}

/**
 * Daily uptime of one monitor over the last `days` days, or null until it has loaded (or when it failed).
 * A response for an earlier monitor/range is ignored, so a slow request can never overwrite newer data.
 */
export function useMonitorUptime(monitorId: number, days: number): MonitorUptime | null {
  const key = `${monitorId}:${days}`
  const [result, setResult] = useState<{ key: string; uptime: MonitorUptime } | null>(null)

  useEffect(() => {
    let cancelled = false
    getJSON<MonitorUptime>(`/api/v1/public/monitor/${monitorId}/uptime?days=${days}`)
      .then((uptime) => { if (!cancelled) setResult({ key: `${monitorId}:${days}`, uptime }) })
      .catch(() => { /* keep the placeholder bars */ })
    return () => { cancelled = true }
  }, [monitorId, days])

  return result?.key === key ? result.uptime : null
}
