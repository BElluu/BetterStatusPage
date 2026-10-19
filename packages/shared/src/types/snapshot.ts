import type { LocaleSummary } from '@better-kit/contracts'

/**
 * The public status page frozen at one moment (`snapshot.json`). A copy of the page hosted elsewhere
 * answers its public API calls from it. Bump `schemaVersion` when a reader of an older file would break.
 */
export interface StatusSnapshot {
  schemaVersion: 1
  /** Epoch milliseconds the snapshot was taken. */
  generatedAt: number
  /** How often the snapshot is renewed, in seconds; a reader judges its age by it. Absent in older files. */
  intervalSeconds?: number
  /** False hides the banner that says this is a saved copy. Absent means shown. */
  showBanner?: boolean
  /** Body of `/api/v1/public/status`. */
  status: unknown
  /** Body of `/api/v1/public/layout`. */
  layout: unknown
  /** The newest incidents, as `/api/v1/public/incidents` lists them. */
  incidents: unknown[]
  /** Body of `/api/v1/public/monitor/:id/uptime?days=90`, by monitor id. */
  uptime: Record<string, { days: unknown[]; overallUptimePct: number | null }>
  /** Body of `/api/v1/public/monitor/:id/history`, by `monitorId:hours:buckets`, for each chart block of the layout. */
  history?: Record<string, { monitorId: number; hours: number; buckets: unknown[] }>
  locales: LocaleSummary[]
  /** Translation overrides by locale code, as `/api/v1/public/locales/:code` returns them. */
  translations: Record<string, Record<string, string>>
}
