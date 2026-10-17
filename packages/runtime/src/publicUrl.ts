/**
 * The absolute base URL the application is reached at, from the `PUBLIC_URL` environment variable.
 *
 * It is deployment configuration, not an admin setting: links in emails and redirects are built from it, so changing
 * it must require access to the server — an account in the admin console alone must not be able to point those links
 * at another domain.
 *
 * The returned function reports an invalid value once per distinct value, then keeps answering ''.
 */
export function createPublicUrlResolver() {
  let warnedAbout: string | null = null

  return function resolvePublicUrl(env: NodeJS.ProcessEnv = process.env): string {
    const raw = (env['PUBLIC_URL'] ?? '').trim().replace(/\/+$/, '')
    if (!raw) return ''
    try {
      const url = new URL(raw)
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.search && !url.hash) return raw
    } catch { /* reported below */ }
    if (warnedAbout !== raw) {
      warnedAbout = raw
      console.warn(`PUBLIC_URL "${raw}" is not an absolute http(s) URL without query or fragment — ignoring it`)
    }
    return ''
  }
}
