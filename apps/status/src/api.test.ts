import { describe, expect, it, vi } from 'vitest'
import { ApiError, getJSON } from './api'

function respond(body: unknown, init?: ResponseInit) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(typeof body === 'string' ? body : JSON.stringify(body), init))
}

describe('getJSON', () => {
  it('returns the parsed body and forwards the request options', async () => {
    const fetchMock = respond({ ok: 1 })

    await expect(getJSON<{ ok: number }>('/api/v1/public/status', { cache: 'no-cache' })).resolves.toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/public/status', { cache: 'no-cache' })
  })

  it('calls fetch with the path alone when no options are given', async () => {
    const fetchMock = respond([])
    await getJSON('/api/v1/public/locales')
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/public/locales')
  })

  it('rejects a non-2xx response with the server error message and status', async () => {
    respond({ error: 'Monitor not found' }, { status: 404 })

    const error = await getJSON('/api/v1/public/monitor/9/uptime').catch((err: unknown) => err)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ message: 'Monitor not found', status: 404 })
  })

  it('falls back to a generic message when the error body is not JSON', async () => {
    respond('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' })
    await expect(getJSON('/x')).rejects.toMatchObject({ message: 'Request failed with status 502 Bad Gateway', status: 502 })
  })

  it('normalises network failures and malformed success bodies', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(getJSON('/x')).rejects.toMatchObject({ name: 'ApiError', message: 'Failed to fetch', status: 0 })

    respond('not json', { status: 200 })
    await expect(getJSON('/x')).rejects.toMatchObject({ name: 'ApiError', message: 'Invalid JSON in response', status: 200 })
  })
})
