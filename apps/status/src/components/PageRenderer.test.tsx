import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LayoutTree, Monitor } from '@bsp/shared'
import { PageRenderer } from './PageRenderer'

vi.mock('../i18n/LocaleContext', () => ({
  useLocale: () => ({ locale: 'en', t: (key: string) => key }),
}))

vi.mock('./ResponseTimeChart', () => ({
  ResponseTimeChart: ({ title }: { title?: string }) => <div>{title ?? 'Response chart'}</div>,
}))

const monitors: Monitor[] = [
  {
    id: 1, name: 'Public API', type: 'https', intervalSecs: 60, timeoutMs: 1_000, retries: 1,
    config: { url: 'https://example.test', method: 'GET', expectedStatus: 200 }, currentStatus: 'up',
    lastCheckedAt: null, webhookToken: null, tags: [], createdAt: 1, updatedAt: 1,
  },
  {
    id: 2, name: 'Database', type: 'ping', intervalSecs: 60, timeoutMs: 1_000, retries: 1,
    config: { host: 'db', mode: 'tcp', port: 5432 }, currentStatus: 'down',
    lastCheckedAt: null, webhookToken: null, tags: [], createdAt: 1, updatedAt: 1,
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
