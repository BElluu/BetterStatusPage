

const REFRESH_MS = 6 * 60 * 60 * 1000

const RETRY_MS = 5 * 60 * 1000

const TIMEOUT_MS = 5_000

export interface LatestRelease {
  version: string
  url: string
}

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

/**
 * Asks GitHub which release of `repository` ("owner/name") is newest and remembers it, to point out an update to
 * whoever runs an older `version()`. All state is in the returned closure.
 */
export function createUpdateCheck(options: { name: string; repository: string; version: () => string }) {
  const RELEASES_API = `https://api.github.com/repos/${options.repository}/releases/latest`
  const resolveAppVersion = options.version

  let latest: LatestRelease | null = null

  let timer: NodeJS.Timeout | undefined

  /** Bumped by every start and stop, so a check still in flight when the service stops cannot schedule another. */
  let generation = 0

  /** The newest published release, null when there is none a user should be pointed at; throws when GitHub cannot be asked. */
  async function fetchLatestRelease(): Promise<LatestRelease | null> {
    const response = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `${options.name}/${resolveAppVersion()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return null
    const { tag_name: tag, html_url: url, draft, prerelease } = body as Record<string, unknown>
    if (typeof tag !== 'string' || typeof url !== 'string' || draft === true || prerelease === true) return null
    if (!parseVersion(tag) || !url.startsWith(`https://github.com/${options.repository}/`)) return null
    return { version: tag.replace(/^v/, ''), url }
  }

  /** Asks GitHub once and remembers the answer; true when it could be asked. Never throws. */
  async function checkForUpdate(): Promise<boolean> {
    try {
      latest = await fetchLatestRelease()
      return true
    } catch {
      return false
    }
  }

  /** Checks now, in the background, then every few hours (sooner after a failure). A no-op when `UPDATE_CHECK=false`. */
  function startUpdateCheck(): void {
    stopUpdateCheck()
    if (!updateCheckEnabled()) return
    const mine = generation
    const run = async () => {
      const asked = await checkForUpdate()
      if (mine !== generation) return
      timer = setTimeout(() => void run(), asked ? REFRESH_MS : RETRY_MS)
      timer.unref()
    }
    void run()
  }

  function stopUpdateCheck(): void {
    generation++
    clearTimeout(timer)
    timer = undefined
  }

  /** The newest release when it is newer than the running version, else null. Reads what the background check found. */
  function getAvailableUpdate(): LatestRelease | null {
    if (!updateCheckEnabled() || !latest) return null
    return isNewerVersion(latest.version, resolveAppVersion()) ? latest : null
  }

  function resetUpdateCheck(): void {
    stopUpdateCheck()
    latest = null
  }

  return { checkForUpdate, startUpdateCheck, stopUpdateCheck, getAvailableUpdate, resetUpdateCheck }
}
