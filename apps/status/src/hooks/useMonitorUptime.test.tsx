import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useMonitorUptime, type MonitorUptime } from './useMonitorUptime'

function uptimeFor(pct: number): MonitorUptime {
  return { days: [{ date: '2026-09-01', status: 'up', uptimePct: pct }], overallUptimePct: pct }
}

/** Fetch whose responses are released by hand, so tests control their order. */
function deferredFetch() {
  const pending = new Map<string, (body: unknown) => void>()
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => new Promise((resolve) => {
    pending.set(String(input), (body) => resolve(new Response(JSON.stringify(body))))
  }))
  return { fetchMock, release: (url: string, body: unknown) => pending.get(url)!(body) }
}

describe('useMonitorUptime', () => {
  it('loads the uptime of a monitor for the requested range', async () => {
    const { fetchMock, release } = deferredFetch()
    const { result } = renderHook(() => useMonitorUptime(3, 30))

    expect(result.current).toEqual({ uptime: null, failed: false })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/public/monitor/3/uptime?days=30')
    release('/api/v1/public/monitor/3/uptime?days=30', uptimeFor(99.5))

    await waitFor(() => expect(result.current).toEqual({ uptime: uptimeFor(99.5), failed: false }))
  })

  it('ignores a stale response that arrives after the monitor changed', async () => {
    const { release } = deferredFetch()
    const { result, rerender } = renderHook(({ id }) => useMonitorUptime(id, 30), { initialProps: { id: 1 } })

    rerender({ id: 2 })
    release('/api/v1/public/monitor/2/uptime?days=30', uptimeFor(50))
    await waitFor(() => expect(result.current.uptime?.overallUptimePct).toBe(50))

    release('/api/v1/public/monitor/1/uptime?days=30', uptimeFor(10))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.current.uptime?.overallUptimePct).toBe(50)
  })

  it('reports a failed request instead of loading forever', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }))
    const { result } = renderHook(() => useMonitorUptime(4, 30))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    await waitFor(() => expect(result.current).toEqual({ uptime: null, failed: true }))
  })
})
