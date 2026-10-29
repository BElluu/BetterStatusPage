import type { IncomingHttpHeaders } from 'node:http'

function parse(publicUrl: string | undefined): URL | null {
  if (!publicUrl) return null
  try { return new URL(publicUrl) } catch { return null }
}

/**
 * Why a request must not reach the endpoint, or null. Clients of this endpoint (CLI tools, desktop apps) send no
 * `Origin`; a browser always does, so any foreign origin is refused whatever the method. With a public URL known the
 * `Host` header must be that host too, so a name that resolves to this server by DNS rebinding gets nothing.
 */
export function crossSiteProblem(headers: IncomingHttpHeaders, publicUrl: string | undefined): string | null {
  const own = parse(publicUrl)
  const origin = headers.origin
  if (origin !== undefined && origin !== own?.origin) return 'Requests from a web page are not accepted'
  if (own && headers.host?.toLowerCase() !== own.host.toLowerCase()) return 'The Host header does not match the public URL'
  return null
}
