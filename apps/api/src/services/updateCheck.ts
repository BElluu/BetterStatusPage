import { resolveAppVersion } from '../version.js'

const RELEASES_API = 'https://api.github.com/repos/BElluu/BetterStatusPage/releases/latest'
const CACHE_MS = 6 * 60 * 60 * 1000
const RETRY_MS = 15 * 60 * 1000
const TIMEOUT_MS = 5_000

export interface LatestRelease {
  version: string
  url: string
}

let cache: { release: LatestRelease | null; checkedAt: number; ttl: number } | null = null
let inFlight: Promise<LatestRelease | null> | null = null

/** `UPDATE_CHECK=false` keeps the instance from contacting GitHub (air-gapped or privacy-minded installs). */
export function updateCheckEnabled(environment: { UPDATE_CHECK?: string | undefined } = process.env): boolean {
  return environment.UPDATE_CHECK?.trim().toLowerCase() !== 'false'
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/** True when `candidate` is a higher x.y.z than `current`; false when either is not a plain release version. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!
  }
  return false
}

async function fetchLatestRelease(): Promise<LatestRelease | null> {
  const response = await fetch(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `BetterStatusPage/${resolveAppVersion()}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) return null
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) return null
  const { tag_name: tag, html_url: url, draft, prerelease } = body as Record<string, unknown>
  if (typeof tag !== 'string' || typeof url !== 'string' || draft === true || prerelease === true) return null
  if (!parseVersion(tag) || !url.startsWith('https://github.com/BElluu/BetterStatusPage/')) return null
  return { version: tag.replace(/^v/, ''), url }
}

/** The newest published release when it is newer than the running version, else null. Cached; never throws. */
export async function getAvailableUpdate(): Promise<LatestRelease | null> {
  if (!updateCheckEnabled()) return null
  const now = Date.now()
  if (!cache || now - cache.checkedAt > cache.ttl) {
    inFlight ??= fetchLatestRelease()
      .then((release) => { cache = { release, checkedAt: Date.now(), ttl: release ? CACHE_MS : RETRY_MS }; return release })
      .catch(() => { cache = { release: null, checkedAt: Date.now(), ttl: RETRY_MS }; return null })
      .finally(() => { inFlight = null })
    await inFlight
  }
  const release = cache?.release ?? null
  return release && isNewerVersion(release.version, resolveAppVersion()) ? release : null
}

export function resetUpdateCheckCache(): void {
  cache = null
}
