import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LayoutTree, PublicMonitor } from '@bsp/shared'
import { PageRenderer } from './PageRenderer'

vi.mock('../i18n/LocaleContext', () => ({
  useLocale: () => ({ locale: 'en', t: (key: string) => key }),
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
  it('renders text, monitor, divider, and chart nodes', () => {
    const tree: LayoutTree = {
      id: 'root', type: 'page', children: [
        { id: 'intro', type: 'text', name: 'Intro', markdown: '# Service health' },
        { id: 'monitor', type: 'monitor', monitorId: 1, showUptimeBar: false },
        { id: 'divider', type: 'divider' },
        { id: 'chart', type: 'chart', monitorId: 1, title: 'Latency', hours: 24, buckets: 30, aggregation: 'avg' },
      ],
    }
    render(<PageRenderer tree={tree} monitors={monitors} statusMap={{ 1: { status: 'down', responseMs: 500, checkedAt: 1 } }} />)

    expect(screen.getByRole('heading', { name: 'Service health' })).toBeInTheDocument()
    expect(screen.getAllByText('Public API').length).toBeGreaterThan(0)
    expect(screen.getByText('status.outage')).toBeInTheDocument()
    expect(screen.getByText('Latency')).toBeInTheDocument()
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

    expect(screen.getByText('MAINTENANCE')).toBeInTheDocument()
    expect(screen.getByText(/status.affectedBy/)).toHaveTextContent('Database')
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
})
