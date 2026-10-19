/** Where the public page is mirrored to, and how often (S3-compatible storage). */
export interface StaticMirrorSettings {
  enabled: boolean
  /** Base URL of an S3-compatible service; empty for AWS S3. */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  /** Read back as the mask when one is stored. Sending the mask keeps the stored value. */
  secretAccessKey: string
  intervalSeconds: number
  /** Show visitors of the copy a banner saying when it was taken. Off makes the copy look like the live page. */
  showBanner: boolean
}

export interface StaticMirrorStatus {
  lastRunAt: number | null
  lastSuccessAt: number | null
  /** The error of the latest run; null when it succeeded. */
  lastError: string | null
  lastUploadedFiles: number
  /** What the copy holds after the last successful push; null before the first. */
  copyFiles: number | null
  copyBytes: number | null
}

/** One push, as the history of the page lists it. */
export interface StaticMirrorRun {
  at: number
  ok: boolean
  uploadedFiles: number
  error: string | null
}

/** The answer to trying a key against a bucket without pushing anything. */
export interface StaticMirrorCheckResult {
  ok: boolean
  error: string | null
}

/** `pending`: switched on, nothing pushed yet. */
export type StaticMirrorHealthState = 'disabled' | 'pending' | 'ok' | 'error' | 'stale'

export interface AdminStaticMirror {
  settings: StaticMirrorSettings
  status: StaticMirrorStatus
  health: StaticMirrorHealthState
  /** The latest pushes, oldest first. */
  runs: StaticMirrorRun[]
}
