export interface UrlRedaction {
  /** Query parameters whose value is replaced. Names are compared after decoding, ignoring case. */
  queryParams?: readonly string[] | undefined
  /** Paths whose next segment is a capability token (`/t/` hides `abc` in `/t/abc?x=1`), matched after percent-decoding as the router does. */
  pathTokenPrefixes?: readonly string[] | undefined
}

const REDACTED = '[redacted]'

function decodeName(name: string): string {
  try { return decodeURIComponent(name.replace(/\+/g, ' ')) } catch { return name }
}

/**
 * The router decodes the path before it matches a route (`/%68ook/` reaches `/hook/`), but keeps an encoded slash.
 * Each segment is decoded on its own, so one malformed sequence leaves only that segment as it was sent.
 */
function decodePath(path: string): string {
  return path.split('/').map((segment) => {
    try { return decodeURI(segment) } catch { return segment }
  }).join('/')
}

/** The URL as it may be logged: capability tokens in the path and the values of secret query parameters are hidden. */
export function redactUrl(url: string, rules: UrlRedaction): string {
  const queryAt = url.indexOf('?')
  let path = queryAt === -1 ? url : url.slice(0, queryAt)
  let query = queryAt === -1 ? '' : url.slice(queryAt + 1)

  const decoded = decodePath(path)
  for (const prefix of rules.pathTokenPrefixes ?? []) {
    // Everything from the token on is dropped: the rest of a path is not decoded text a log should repeat.
    if (decoded.startsWith(prefix) && decoded.length > prefix.length) {
      path = `${prefix}${REDACTED}`
      break
    }
  }

  const names = (rules.queryParams ?? []).map((name) => name.toLowerCase())
  if (names.length > 0 && query) {
    query = query.split('&').map((pair) => {
      const equals = pair.indexOf('=')
      if (equals === -1) return pair
      return names.includes(decodeName(pair.slice(0, equals)).toLowerCase()) ? `${pair.slice(0, equals + 1)}${REDACTED}` : pair
    }).join('&')
  }

  return queryAt === -1 ? path : `${path}?${query}`
}
