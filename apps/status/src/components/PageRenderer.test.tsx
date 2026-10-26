import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LayoutTree, PublicMonitor } from '@bsp/shared'
import { PageRenderer } from './PageRenderer'

vi.mock('../i18n/LocaleContext', () => ({
  useLocale: () => ({ locale: 'en', t: (key: string) => key }),
}))

const uptimeState = vi.hoisted(() => ({
  value: { uptime: null, failed: false } as { uptime: unknown; failed: boolean },
}))

vi.mock('../hooks/useMonitorUptime', () => ({
  useMonitorUptime: () => uptimeState.value,
}))

vi.mock('./ResponseTimeChart', () => ({
  ResponseTimeChart: ({ title }: { title?: string }) => <div>{title ?? 'Response chart'}</div>,
}))

const monitors: PublicMonitor[] = [
  {
    id: 1, name: 'Public API', type: 'https', currentStatus: 'up', lastCheckedAt: null,
  },
  {
    id: 2, name: 'Database', type: 'ping', currentStatus: 'down', lastCheckedAt: null,
  },
]

describe('PageRenderer', () => {
  it('renders text, monitor, divider, and chart nodes', async () => {
    const tree: LayoutTree = {
      id: 'root', type: 'page', children: [
        { id: 'intro', type: 'text', name: 'Intro', markdown: '# Service health' },
        { id: 'monitor', type: 'monitor', monitorId: 1, showUptimeBar: false },
        { id: 'divider', type: 'divider' },
        { id: 'chart', type: 'chart', monitorId: 1, title: 'Latency', hours: 24, buckets: 30, aggregation: 'avg' },
      ],
    }
    render(<PageRenderer tree={tree} monitors={monitors} statusMap={{ 1: { status: 'down', responseMs: 500, checkedAt: 1 } }} />)

    expect(await screen.findByRole('heading', { name: 'Service health' })).toBeInTheDocument()
    expect(screen.getAllByText('Public API').length).toBeGreaterThan(0)
    expect(screen.getByText('status.outage')).toBeInTheDocument()
    expect(await screen.findByText('Latency')).toBeInTheDocument()
  })

  it('shows uptime % in the chart block only when asked', async () => {
    uptimeState.value = { uptime: { overallUptimePct: 99.5, days: [] }, failed: false }
    const chart = { id: 'chart', type: 'chart', monitorId: 1, hours: 720, buckets: 30, aggregation: 'avg' } as const
    const { rerender } = render(<PageRenderer tree={{ id: 'root', type: 'page', children: [chart] }} monitors={monitors} statusMap={{}} />)
    expect(await screen.findByText('Response chart')).toBeInTheDocument()
    expect(screen.queryByText('uptime.pct')).not.toBeInTheDocument()

    rerender(<PageRenderer tree={{ id: 'root', type: 'page', children: [{ ...chart, showUptime: true }] }} monitors={monitors} statusMap={{}} />)
    expect(await screen.findByText('uptime.pct')).toBeInTheDocument()
    uptimeState.value = { uptime: null, failed: false }
  })

  it('shows maintenance and dependency causes', () => {
    const tree: LayoutTree = {
      id: 'root', type: 'page', children: [
        { id: 'monitor', type: 'monitor', monitorId: 1, showUptimeBar: false },
      ],
    }
    render(
      <PageRenderer
        tree={tree}
        monitors={monitors}
        statusMap={{ 1: { status: 'affected', responseMs: null, checkedAt: 1 } }}
        maintenanceMonitorIds={new Set([1])}
        dependencyMap={{ 1: [2] }}
      />,
    )

    expect(screen.getByText('page.maintenance')).toBeInTheDocument()
    expect(screen.getByText(/status.affectedBy/)).toHaveTextContent('Database')
  })

  it('shows the display name of a monitor node instead of the monitor name', () => {
    const tree: LayoutTree = {
      id: 'root', type: 'page', children: [
        { id: 'monitor', type: 'monitor', monitorId: 1, displayName: 'Customer portal', showUptimeBar: false },
      ],
    }
    render(<PageRenderer tree={tree} monitors={monitors} statusMap={{}} />)
    expect(screen.getByText('Customer portal')).toBeInTheDocument()
    expect(screen.queryByText('Public API')).not.toBeInTheDocument()
  })

  it('shows the display name of a monitor node inside a group', () => {
    const tree: LayoutTree = {
      id: 'root', type: 'page', children: [{
        id: 'group', type: 'group', label: 'Core systems', collapsible: false,
        children: [{ id: 'monitor', type: 'monitor', monitorId: 1, displayName: 'Customer portal', showUptimeBar: false }],
      }],
    }
    render(<PageRenderer tree={tree} monitors={monitors} statusMap={{}} />)
    expect(screen.getByText('Customer portal')).toBeInTheDocument()
    expect(screen.queryByText('Public API')).not.toBeInTheDocument()
  })

  it('renders group children and ignores missing monitors', () => {
    const tree: LayoutTree = {
      id: 'root', type: 'page', children: [{
        id: 'group', type: 'group', label: 'Core systems', collapsible: false,
        children: [
          { id: 'valid', type: 'monitor', monitorId: 1, showUptimeBar: false },
          { id: 'missing', type: 'monitor', monitorId: 999, showUptimeBar: false },
        ],
      }],
    }
    render(<PageRenderer tree={tree} monitors={monitors} statusMap={{}} />)
    expect(screen.getByText('Core systems')).toBeInTheDocument()
    expect(screen.getByText('Public API')).toBeInTheDocument()
  })

  it('keeps the full monitor name available as a hover hint', () => {
    const longName = 'A very long production service name that may not fit in the card'
    const tree: LayoutTree = {
      id: 'root', type: 'page', children: [
        { id: 'monitor', type: 'monitor', monitorId: 3, showUptimeBar: false },
      ],
    }

    render(<PageRenderer
      tree={tree}
      monitors={[{ id: 3, name: longName, type: 'https', currentStatus: 'up', lastCheckedAt: null }]}
      statusMap={{}}
    />)

    expect(screen.getByRole('heading', { name: longName })).toHaveAttribute('title', longName)
  })

  describe('uptime bars', () => {
    const tree: LayoutTree = {
      id: 'root', type: 'page', children: [
        { id: 'monitor', type: 'monitor', monitorId: 2, showUptimeBar: true, uptimeBarPosition: 'below' },
      ],
    }

    it('shows neutral placeholders while loading, without made-up days', () => {
      uptimeState.value = { uptime: null, failed: false }
      const { container } = render(<PageRenderer tree={tree} monitors={monitors} statusMap={{}} />)
      expect(container.querySelectorAll('.bsp-uptime-bar')).toHaveLength(0)
      expect(screen.queryByText('uptime.noData')).not.toBeInTheDocument()
    })

    it('says there is no data when the history request failed', () => {
      uptimeState.value = { uptime: null, failed: true }
      render(<PageRenderer tree={tree} monitors={monitors} statusMap={{}} />)
      expect(screen.getByText('uptime.noData')).toBeInTheDocument()
    })

    it('renders one focusable bar per day, labelled for keyboard and screen reader users', async () => {
      uptimeState.value = {
        uptime: {
          overallUptimePct: 90,
          days: [
            { date: '2026-09-01', status: 'up', uptimePct: 100 },
            { date: '2026-09-02', status: 'down', uptimePct: 80 },
          ],
        },
        failed: false,
      }
      const { container } = render(<PageRenderer tree={tree} monitors={monitors} statusMap={{}} />)
      const bars = container.querySelectorAll<HTMLButtonElement>('button.bsp-uptime-bar')
      expect(bars).toHaveLength(2)
      expect(bars[0]).toHaveAttribute('aria-label', 'uptime.barLabel')

      fireEvent.focus(bars[1]!)
      // The tooltip opens on focus, not only on hover.
      expect(await screen.findByText('uptime.noIncidents')).toBeInTheDocument()
    })

    it('shows a day spent in maintenance as maintenance, and notes maintenance on a mixed day', async () => {
      uptimeState.value = {
        uptime: {
          overallUptimePct: 100,
          days: [
            { date: '2026-09-01', status: 'maintenance', uptimePct: 100, maintenanceChecks: 4 },
            { date: '2026-09-02', status: 'up', uptimePct: 100, maintenanceChecks: 2 },
          ],
        },
        failed: false,
      }
      const { container } = render(<PageRenderer tree={tree} monitors={monitors} statusMap={{}} />)
      const bars = container.querySelectorAll<HTMLButtonElement>('button.bsp-uptime-bar')

      fireEvent.focus(bars[0]!)
      expect(await screen.findByText('uptime.maintenance')).toBeInTheDocument()
      expect(screen.queryByText('uptime.pct')).not.toBeInTheDocument()
      expect(screen.queryByText('uptime.noData')).not.toBeInTheDocument()
      fireEvent.blur(bars[0]!)

      fireEvent.focus(bars[1]!)
      expect(await screen.findByText('uptime.partlyMaintenance')).toBeInTheDocument()
      expect(screen.getByText('uptime.pct')).toBeInTheDocument()
    })
  })

  it('shows an incident-affected monitor as degraded instead of operational', () => {
    const tree: LayoutTree = {
      id: 'root', type: 'page', children: [
        { id: 'monitor', type: 'monitor', monitorId: 1, showUptimeBar: false },
      ],
    }

    render(<PageRenderer
      tree={tree}
      monitors={monitors}
      statusMap={{}}
      activeIncidents={[{
        id: 10,
        title: 'Google incident',
        status: 'investigating',
        impact: 'minor',
        startedAt: 1,
        resolvedAt: null,
        createdAt: 1,
        updatedAt: 1,
        draft: false,
        autoMonitorId: null,
        monitorIds: [1],
      }]}
    />)

    expect(screen.getByText('status.degraded')).toBeInTheDocument()
    expect(screen.queryByText('status.operational')).not.toBeInTheDocument()
  })
})
