import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSSE } from './useSSE'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  listeners = new Map<string, Array<(event: MessageEvent) => void>>()
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  close = vi.fn()

  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback = listener as (event: MessageEvent) => void
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback])
  }

  emit(type: string, data: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(data) }))
    }
  }
}

describe('useSSE', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  it('updates monitor state and reports incident changes', () => {
    const onIncidentChange = vi.fn()
    const { result, unmount } = renderHook(() => useSSE(onIncidentChange))
    const source = FakeEventSource.instances[0]!
    expect(source.url).toBe('/api/v1/public/events')

    act(() => source.emit('monitor.status', { monitorId: 5, status: 'down', responseMs: 120, checkedAt: 10 }))
    expect(result.current[5]).toEqual({ status: 'down', responseMs: 120, checkedAt: 10 })

    act(() => source.emit('incident.created'))
    act(() => source.emit('incident.updated'))
    expect(onIncidentChange).toHaveBeenCalledTimes(2)

    unmount()
    expect(source.close).toHaveBeenCalled()
  })

  it('closes a failed connection and retries after about two seconds', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { unmount } = renderHook(() => useSSE())
    const first = FakeEventSource.instances[0]!

    act(() => first.onerror?.())
    expect(first.close).toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(2_000))
    expect(FakeEventSource.instances).toHaveLength(2)

    unmount()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('backs off while the stream keeps failing and refreshes by polling meanwhile', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const onIncidentChange = vi.fn()
    const { unmount } = renderHook(() => useSSE(onIncidentChange))

    act(() => FakeEventSource.instances[0]!.onerror?.())
    act(() => vi.advanceTimersByTime(2_000))
    act(() => FakeEventSource.instances[1]!.onerror?.())
    act(() => vi.advanceTimersByTime(3_999))
    expect(FakeEventSource.instances).toHaveLength(2)
    act(() => vi.advanceTimersByTime(1))
    expect(FakeEventSource.instances).toHaveLength(3)

    expect(onIncidentChange).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(30_000))
    expect(onIncidentChange).toHaveBeenCalled()

    // A stream that opens again stops the polling and resets the delay.
    FakeEventSource.instances[2]!.onopen?.()
    onIncidentChange.mockClear()
    act(() => vi.advanceTimersByTime(60_000))
    expect(onIncidentChange).not.toHaveBeenCalled()

    unmount()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('forgets statuses received over a stream that dropped, so the refetched data wins', () => {
    vi.useFakeTimers()
    const { result, unmount } = renderHook(() => useSSE())
    const source = FakeEventSource.instances[0]!
    act(() => source.emit('monitor.status', { monitorId: 5, status: 'down', responseMs: 120, checkedAt: 10 }))
    expect(result.current[5]).toBeDefined()

    act(() => source.onerror?.())
    expect(result.current[5]).toBeUndefined()

    unmount()
    vi.useRealTimers()
  })
})
