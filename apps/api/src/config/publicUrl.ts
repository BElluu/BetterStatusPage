/**
 * Absolute base URL of the public status page, from the `PUBLIC_URL` environment variable.
 *
 * It is deployment configuration, not an admin setting: every confirmation and unsubscribe link
 * in subscriber emails is built from it, so changing it must require access to the server — an
 * operator account alone must not be able to point those links at another domain.
 */
let warnedAbout: string | null = null

export function resolvePublicUrl(env: NodeJS.ProcessEnv = process.env): string {
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
