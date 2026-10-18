/** Replaces `{{name}}` with its value; a name without a value stays as written. `escape` is applied to each value. */
export function substituteVars(template: string, vars: Record<string, string>, escape?: (value: string) => string): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key]
    return value === undefined ? `{{${key}}}` : escape ? escape(value) : value
  })
}

/** Escapes a value for use inside a JSON string literal in a template. */
export function escapeJsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

/**
 * Encodes a value as one piece of a path or query. A value that is only dots would be a dot segment (`..` climbs a level, and
 * so does its `%2E` form), so its dots are encoded once more and arrive as the text `%2E`.
 */
export function encodeUrlPart(value: string): string {
  const text = withoutLoneSurrogates(value)
  return /^\.{1,2}$/.test(text) ? text.replace(/\./g, '%252E') : encodeURIComponent(text)
}

/** `encodeURIComponent` throws on a lone surrogate; it becomes U+FFFD, as in any other encoding of the text. */
function withoutLoneSurrogates(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0)!
    out += code >= 0xd800 && code <= 0xdfff ? String.fromCharCode(0xfffd) : char
  }
  return out
}

/** Drops line breaks and NUL from a value that goes into a header, where they would split or reject the request. */
export function stripLineBreaks(value: string): string {
  return value.replace(/[\r\n\0]/g, '')
}

/**
 * The request a webhook configuration describes once its {{variables}} are filled in. A value is one piece of a
 * path or query in the URL (so it cannot add a segment, a parameter or a host), a JSON string in the body and a single
 * line in a header.
 */
export function buildWebhookRequest(
  config: { url: string; method: string; headers?: Record<string, string>; body?: string },
  vars: Record<string, string>,
): { url: string; init: { method: string; headers: Record<string, string>; body?: string } } {
  const url = substituteVars(config.url, vars, encodeUrlPart)
  const body = config.body ? substituteVars(config.body, vars, escapeJsonString) : undefined

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.headers) {
    for (const [k, v] of Object.entries(config.headers)) {
      headers[k] = substituteVars(v, vars, stripLineBreaks)
    }
  }

  return { url, init: { method: config.method ?? 'POST', headers, ...(body !== undefined ? { body } : {}) } }
}

/** How often a delivery is tried before it is given up on, and how long to wait before each retry. */
export const MAX_DELIVERY_ATTEMPTS = 3
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000]
