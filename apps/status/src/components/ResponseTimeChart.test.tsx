import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getJSON } from '../api'
import { ResponseTimeChart, type HistoryBucket } from './ResponseTimeChart'

vi.mock('../api', () => ({ getJSON: vi.fn() }))

// recharts' ResponsiveContainer measures its parent; jsdom has no ResizeObserver.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function bucket(ts: number, overrides: Partial<HistoryBucket> = {}): HistoryBucket {
  return { ts, avg: 120, min: 80, max: 400, p95: 300, count: 3, status: 'up', ...overrides }
}

describe('ResponseTimeChart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('requests the configured history window and renders the chart title', async () => {
    vi.mocked(getJSON).mockResolvedValue({
      buckets: [
        bucket(1), bucket(2, { status: 'down' }), bucket(3, { status: 'down' }),
        bucket(4, { status: 'degraded', p95: null }), bucket(5), bucket(6, { status: 'degraded' }),
      ],
    })
    const { container } = render(<ResponseTimeChart monitorId={7} hours={48} buckets={30} aggregation="p95" title="Checkout latency" />)

    expect(container.firstElementChild).toHaveStyle({ alignItems: 'center' })
    expect(await screen.findByText('Checkout latency')).toBeInTheDocument()
    expect(getJSON).toHaveBeenCalledWith('/api/v1/public/monitor/7/history?hours=48&buckets=30')
    expect(container.querySelector('.bsp-chart')).not.toBeNull()
  })

  it('renders a line chart without an area fill', async () => {
    vi.mocked(getJSON).mockResolvedValue({ buckets: [bucket(1), bucket(2)] })
    const { container } = render(<ResponseTimeChart monitorId={1} hours={6} buckets={20} aggregation="avg" showArea={false} />)

    await waitFor(() => expect(container.querySelector('.bsp-chart')).not.toBeNull())
  })

  it('shows an empty state when no checks ran or the request fails', async () => {
    vi.mocked(getJSON).mockResolvedValueOnce({ buckets: [bucket(1, { count: 0, avg: null })] })
    const { unmount } = render(<ResponseTimeChart monitorId={1} hours={24} buckets={20} aggregation="max" />)
    expect(await screen.findByText('No data for this period')).toBeInTheDocument()
    unmount()

    vi.mocked(getJSON).mockRejectedValueOnce(new Error('offline'))
    render(<ResponseTimeChart monitorId={1} hours={24} buckets={20} aggregation="max" />)
    expect(await screen.findByText('No data for this period')).toBeInTheDocument()
  })
})
