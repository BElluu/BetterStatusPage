/** A failed public API request: `status` is the HTTP status, or 0 when the request never got a response. */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * Fetches a public API path and parses the JSON body. Non-2xx responses and network failures both reject with
 * an {@link ApiError}, so callers never mistake an error payload for data.
 */
export async function getJSON<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await (init ? fetch(path, init) : fetch(path))
  } catch (err) {
    throw new ApiError(err instanceof Error && err.message ? err.message : 'Network request failed', 0)
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: unknown } | null
    const message = typeof body?.error === 'string' && body.error
      ? body.error
      : `Request failed with status ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`
    throw new ApiError(message, res.status)
  }

  try {
    return await res.json() as T
  } catch {
    throw new ApiError('Invalid JSON in response', res.status)
  }
}
