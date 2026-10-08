/** Uptime of one monitor over a report range; days are UTC calendar days, like the status page bars. */
export interface UptimeReportMonitor {
  monitorId: number
  monitorName: string
  checksTotal: number
  checksUp: number
  /** Null when the monitor has no results in the range. */
  uptimePct: number | null
  avgResponseMs: number | null
  /** Incidents linked to the monitor that overlap the range. */
  incidents: number
}

export interface UptimeReport {
  /** First and last day of the range, `YYYY-MM-DD`, both included. */
  from: string
  to: string
  /** Days check results are kept; earlier days of the range have no data. */
  retentionDays: number
  monitors: UptimeReportMonitor[]
}
