import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Monitor, MonitorStats } from '@bsp/shared'
import { api } from '../api/client'
import { ToastProvider } from '../components/ui'
import MonitorDetailPage from './MonitorDetail'

vi.mock('../components/YamlViewModal', () => ({
  YamlViewModal: ({ kind, objectKey, onClose }: { kind: string; objectKey?: string; onClose: () => void }) => (
    <div role="dialog" aria-label="YAML view">{kind} {objectKey ?? ''}<button type="button" onClick={onClose}>Close YAML</button></div>
  ),
}))

vi.mock('../api/client', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../components/monitors/MonitorFormModal', () => ({
  default: ({ monitor }: { monitor: Monitor }) => <div role="dialog" aria-label="Edit monitor form">{monitor.name}</div>,
}))

// recharts' ResponsiveContainer measures its parent; jsdom has no ResizeObserver.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const monitor = {
  id: 7, key: 'checkout-api', name: 'Checkout API', type: 'https', intervalSecs: 60, timeoutMs: 10_000, failureThreshold: 2, recoveryThreshold: 1,
  currentStatus: 'up', lastCheckedAt: 1_700_000_000_000, certExpiresAt: null, tags: [],
  config: { url: 'https://api.shop.example/health' },
} as unknown as Monitor

const now = Date.now()
const stats: MonitorStats = {
  monitorId: 7, hours: 168, from: now - 168 * 3_600_000, to: now, retentionDays: 90,
  checksTotal: 1000, checksUp: 999, uptimePct: 99.9, failures: 1,
  response: { avg: 120, min: 40, max: 2500, p50: 100, p95: 300, p99: 900 },
  buckets: [
    { ts: now - 3_600_000, checksTotal: 10, checksUp: 10, avgMs: 100, minMs: 40, maxMs: 200, p95Ms: 190, down: 0, degraded: 0 },
    { ts: now, checksTotal: 10, checksUp: 9, avgMs: 140, minMs: 50, maxMs: 2500, p95Ms: 900, down: 1, degraded: 0 },
  ],
  uptime: {
    stepHours: 6,
    bars: Array.from({ length: 28 }, (_, i) => ({ ts: now - (28 - i) * 6 * 3_600_000, checksTotal: i === 27 ? 1000 : 0, checksUp: i === 27 ? 999 : 0 })),
  },
  incidents: { total: 1, mttrMs: 5_400_000, recent: [{ id: 1, title: 'Outage', status: 'resolved', impact: 'major', startedAt: now - 7_200_000, resolvedAt: now - 1_800_000 }] },
  recentFailures: [{ checkedAt: now - 1000, status: 'down', responseMs: null, errorMessage: 'connect ECONNREFUSED', unconfirmed: false }],
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/admin/monitors/7']}>
          <Routes><Route path="/admin/monitors/:id" element={<MonitorDetailPage />} /></Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  )
}

describe('MonitorDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.includes('/stats')) return stats
      if (path.includes('/dependencies')) return { dependsOnIds: [3] }
      if (path === '/admin/monitors') return [monitor, { ...monitor, id: 3, name: 'Payments gateway' }]
      return monitor
    })
    vi.mocked(api.post).mockResolvedValue({})
  })

  afterEach(() => vi.unstubAllGlobals())

  it('shows the key figures, configuration, incidents and failures of the monitor', async () => {
    renderPage()
    expect(await screen.findByText('99.900%')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Checkout API/ })).toBeInTheDocument()
    expect(screen.getByText('300ms')).toBeInTheDocument()
    expect(screen.getByText('1 h 30 min')).toBeInTheDocument()
    expect(screen.getByText('Outage')).toBeInTheDocument()
    expect(screen.getByText('connect ECONNREFUSED')).toBeInTheDocument()
    expect(screen.getByText('https://api.shop.example/health')).toBeInTheDocument()
    expect(await screen.findByText('Payments gateway')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Response time chart' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Uptime per 6 hours' }).children).toHaveLength(28)
  })

  it('requests statistics for the chosen range', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('99.900%')
    expect(api.get).toHaveBeenCalledWith('/admin/monitors/7/stats?hours=168')

    await user.click(screen.getByRole('button', { name: '90d' }))
    expect(api.get).toHaveBeenCalledWith('/admin/monitors/7/stats?hours=2160')
  })

  it('runs a check and opens the edit form', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('99.900%')

    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(api.post).toHaveBeenCalledWith('/admin/monitors/7/check-now', {})

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('dialog', { name: 'Edit monitor form' })).toHaveTextContent('Checkout API')
  })

  it('offers a way back when the monitor cannot be loaded', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('Not found'))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load this monitor")
    expect(screen.getByRole('link', { name: 'Back to monitors' })).toHaveAttribute('href', '/admin/monitors')
  })
})

describe('MonitorDetailPage YAML view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.startsWith('/admin/monitors/7/stats')) return stats
      if (path === '/admin/monitors/7') return monitor
      return []
    })
  })

  it('opens the monitor as YAML, by its key', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('99.900%')
    await user.click(screen.getByRole('button', { name: 'YAML' }))
    expect(screen.getByRole('dialog', { name: 'YAML view' })).toHaveTextContent('Monitor checkout-api')
  })
})

describe('MonitorDetailPage webhook URL', () => {
  it('shows the heartbeat URL of a webhook monitor, to copy', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.startsWith('/admin/monitors/7/stats')) return stats
      if (path === '/admin/monitors/7') return { ...monitor, type: 'webhook', webhookToken: 'abc123', config: {} }
      return []
    })
    renderPage()
    expect(await screen.findByText(`${window.location.origin}/api/v1/hook/abc123`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })
})
