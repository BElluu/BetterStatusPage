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

/** The request a webhook configuration describes once its {{variables}} are filled in. */
export function buildWebhookRequest(
  config: { url: string; method: string; headers?: Record<string, string>; body?: string },
  vars: Record<string, string>,
): { url: string; init: { method: string; headers: Record<string, string>; body?: string } } {
  const url = substituteVars(config.url, vars)
  const body = config.body ? substituteVars(config.body, vars, escapeJsonString) : undefined

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.headers) {
    for (const [k, v] of Object.entries(config.headers)) {
      headers[k] = substituteVars(v, vars)
    }
  }

  return { url, init: { method: config.method ?? 'POST', headers, ...(body !== undefined ? { body } : {}) } }
}

/** How often a delivery is tried before it is given up on, and how long to wait before each retry. */
export const MAX_DELIVERY_ATTEMPTS = 3
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000]
