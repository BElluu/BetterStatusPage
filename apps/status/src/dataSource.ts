import type { StatusSnapshot } from '@bsp/shared'
import { ApiError } from './api'

/** The uploaded copy of the page names its snapshot here; the page served by the live instance has no such tag. */
export const SNAPSHOT_URL: string | null =
  document.querySelector<HTMLMetaElement>('meta[name="bsp-snapshot"]')?.content || null

/** For a file that does not say how often it is renewed. */
const SNAPSHOT_DEFAULT_STALE_MS = 10 * 60_000

/** A snapshot older than this is shown as possibly out of date: three of its intervals. */
export function snapshotStaleMs(snapshot: Pick<StatusSnapshot, 'intervalSeconds'>): number {
  return snapshot.intervalSeconds ? 3 * 1000 * snapshot.intervalSeconds : SNAPSHOT_DEFAULT_STALE_MS
}

const isObject = (value: unknown): boolean => !!value && typeof value === 'object'

function isSnapshot(value: unknown): value is StatusSnapshot {
  const s = value as Partial<Record<keyof StatusSnapshot, unknown>> | null
  return isObject(s) && s!.schemaVersion === 1 && typeof s!.generatedAt === 'number'
    && isObject(s!.status) && isObject(s!.layout) && isObject(s!.uptime) && isObject(s!.translations)
    && Array.isArray(s!.incidents) && Array.isArray(s!.locales)
}
const SNAPSHOT_REREAD_MS = 30_000

let cached: { at: number; value: Promise<StatusSnapshot> } | null = null

/** Reads `snapshot.json`, at most once per half a minute however many requests ask for it. */
export function loadSnapshot(url: string): Promise<StatusSnapshot> {
  const now = Date.now()
  if (cached && now - cached.at < SNAPSHOT_REREAD_MS) return cached.value
  const value = fetch(url, { cache: 'no-store' })
    .then((res) => {
      if (!res.ok) throw new ApiError(`Snapshot request failed with status ${res.status}`, res.status)
      return res.json() as Promise<unknown>
    })
    .then((body) => {
      // A newer format, a truncated file or some other JSON must fail here, not deep inside the page.
      if (!isSnapshot(body)) throw new ApiError('The saved copy is not in a format this page understands', 0)
      return body
    })
    .catch((err) => {
      if (cached?.value === value) cached = null
      throw err instanceof ApiError ? err : new ApiError('Snapshot request failed', 0)
    })
  cached = { at: now, value }
  return value
}

const notFound = () => new ApiError('Not available in the saved copy', 404)

/** Answers a public API path from the snapshot, as the live API would. Paths the snapshot cannot serve are a 404. */
export async function answerFromSnapshot<T>(path: string, url: string): Promise<T> {
  const snapshot = await loadSnapshot(url)
  const [pathname = '', query = ''] = path.replace('/api/v1/public/', '').split('?')
  const params = new URLSearchParams(query)

  if (pathname === 'access') {
    return { private: false, signedIn: false, email: null, role: null, passwordChangeRequired: false, branding: null } as T
  }
  if (pathname === 'status') return snapshot.status as T
  if (pathname === 'layout') return snapshot.layout as T
  if (pathname === 'incidents') {
    const limit = Number(params.get('limit') ?? 10)
    return snapshot.incidents.slice(0, Number.isInteger(limit) && limit > 0 ? limit : 10) as T
  }
  if (pathname === 'locales') return snapshot.locales as T

  const locale = /^locales\/([^/]+)$/.exec(pathname)?.[1]
  if (locale) return { translations: snapshot.translations[locale] ?? {} } as T

  const uptimeId = /^monitor\/(\d+)\/uptime$/.exec(pathname)?.[1]
  if (uptimeId) {
    const uptime = snapshot.uptime[uptimeId]
    if (!uptime) throw notFound()
    const asked = uptime.days.slice(-Number(params.get('days') ?? 90)) as Array<{ checksTotal?: number; checksUp?: number }>
    // The live page counts the checks of exactly the days it shows, so the copy does the same.
    const counted = asked.every((day) => typeof day.checksTotal === 'number' && typeof day.checksUp === 'number')
    const total = asked.reduce((sum, day) => sum + (day.checksTotal ?? 0), 0)
    const up = asked.reduce((sum, day) => sum + (day.checksUp ?? 0), 0)
    return { monitorId: Number(uptimeId), ...uptime, days: asked, overallUptimePct: counted ? (total > 0 ? (up / total) * 100 : null) : uptime.overallUptimePct } as T
  }
  const historyId = /^monitor\/(\d+)\/history$/.exec(pathname)?.[1]
  if (historyId) {
    const entry = snapshot.history?.[`${historyId}:${params.get('hours') ?? 24}:${params.get('buckets') ?? 30}`]
    if (!entry) throw notFound()
    return entry as T
  }
  throw notFound()
}
