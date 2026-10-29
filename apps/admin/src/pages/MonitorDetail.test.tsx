import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Monitor, MonitorStats } from '@bsp/shared'
import { api } from '../api/client'
import { ToastProvider } from '@better-forge/ui'
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
  currentStatus: 'up', activity: { maintenance: false, windows: [], incident: null }, lastCheckedAt: 1_700_000_000_000, certExpiresAt: null, tags: [],
  config: { url: 'https://api.shop.example/health' },
  latencyAlertFactor: null, latencyAlertWindowMinutes: 30, latencyAlertMinDeltaMs: 200, latencyAlertSustain: 3, latencyBaselineP95: null, latencyAlertSince: null,
} as unknown as Monitor

const now = Date.now()
const stats: MonitorStats = {
  monitorId: 7, hours: 168, from: now - 168 * 3_600_000, to: now, retentionDays: 90,
  checksTotal: 1000, checksUp: 999, uptimePct: 99.9, failures: 1,
  response: { avg: 120, min: 40, max: 2500, p50: 100, p95: 300, p99: 900 },
  baselineP95Ms: null,
  buckets: [
    { ts: now - 3_600_000, checksTotal: 10, checksUp: 10, avgMs: 100, minMs: 40, maxMs: 200, p95Ms: 190, down: 0, degraded: 0 },
    { ts: now, checksTotal: 10, checksUp: 9, avgMs: 140, minMs: 50, maxMs: 2500, p95Ms: 900, down: 1, degraded: 0 },
  ],
  uptime: {
    stepHours: 6,
    bars: Array.from({ length: 28 }, (_, i) => ({ ts: now - (28 - i) * 6 * 3_600_000, checksTotal: i === 27 ? 1000 : 0, checksUp: i === 27 ? 999 : 0, maintenanceChecks: 0 })),
  },
  incidents: { total: 1, mttrMs: 5_400_000, recent: [{ id: 1, title: 'Outage', status: 'resolved', impact: 'major', startedAt: now - 7_200_000, resolvedAt: now - 1_800_000 }] },
  recentFailures: [{ checkedAt: now - 1000, status: 'down', responseMs: null, errorMessage: 'connect ECONNREFUSED', unconfirmed: false, inMaintenance: false }],
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

  it('shows a running maintenance window and an open incident beside the status', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.includes('/stats')) return stats
      if (path.includes('/dependencies')) return { dependsOnIds: [] }
      if (path === '/admin/monitors') return [monitor]
      return { ...monitor, activity: { maintenance: true, windows: [], incident: 'major' } }
    })
    renderPage()
    // The chip beside the status and the title of the maintenance card.
    expect(await screen.findAllByText('Maintenance')).toHaveLength(2)
    expect(screen.getByText('Incident · major')).toBeInTheDocument()
  })

  it('shows no slower-than-usual notice, chip or usual p95 while there is no alert and no baseline', async () => {
    renderPage()
    expect(await screen.findByText('99.900%')).toBeInTheDocument()
    expect(screen.queryByText('Slower than usual')).not.toBeInTheDocument()
    expect(screen.queryByText(/Usual p95/)).not.toBeInTheDocument()
    expect(screen.queryByText('Slower alert')).not.toBeInTheDocument()
  })

  it('shows the usual p95 and the alert settings once the baseline is known', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.includes('/stats')) return { ...stats, baselineP95Ms: 150 }
      if (path.includes('/dependencies')) return { dependsOnIds: [] }
      if (path === '/admin/monitors') return [monitor]
      return { ...monitor, latencyAlertFactor: 3 }
    })
    renderPage()
    expect(await screen.findByText('Usual p95 · 7 days')).toBeInTheDocument()
    expect(screen.getByText('150ms')).toBeInTheDocument()
    expect(screen.getByText('Slower alert')).toBeInTheDocument()
    expect(screen.getByText('3× usual p95, 30 min')).toBeInTheDocument()
    // No alert is open, so nothing says the monitor is slow.
    expect(screen.queryByText('Slower than usual')).not.toBeInTheDocument()
  })

  it('tells that responses are slower than usual while the alert is open, and where it fires', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.includes('/stats')) return { ...stats, baselineP95Ms: 150 }
      if (path.includes('/dependencies')) return { dependsOnIds: [] }
      if (path === '/admin/monitors') return [monitor]
      return { ...monitor, latencyAlertFactor: 3, latencyAlertSince: Date.now() - 3_600_000 }
    })
    renderPage()
    expect(await screen.findByText('Slower than usual')).toBeInTheDocument()
    expect(screen.getByText(/Responses have been slower than usual since/)).toBeInTheDocument()
    expect(screen.getByText(/The usual p95 is 150ms; the alert fires at 450ms/)).toBeInTheDocument()
    // The status itself is untouched.
    expect(screen.getByRole('heading', { name: /Checkout API/ })).toHaveTextContent('Operational')
  })

  it('shows the effective status in the title and the check result in the summary', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.includes('/stats')) return stats
      if (path.includes('/dependencies')) return { dependsOnIds: [] }
      if (path === '/admin/monitors') return [monitor]
      return { ...monitor, currentStatus: 'up', activity: { maintenance: false, windows: [], incident: 'critical' } }
    })
    renderPage()
    expect(await screen.findByText('Down · incident')).toBeInTheDocument()
    expect(screen.getByText('Check result')).toBeInTheDocument()
    expect(screen.getByText('Operational')).toBeInTheDocument()
  })

  it('lists the running and upcoming maintenance of the monitor', async () => {
    const at = Date.now()
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.includes('/stats')) return stats
      if (path.includes('/dependencies')) return { dependsOnIds: [] }
      if (path === '/admin/monitors') return [monitor]
      return {
        ...monitor,
        activity: {
          maintenance: true, incident: null,
          windows: [
            { id: 1, name: 'DB upgrade', description: null, startsAt: at - 60_000, endsAt: at + 3_600_000, recurrence: 'none', recurrenceDays: [], timezone: 'UTC', recurrenceUntil: null },
            { id: 2, name: 'Nightly backup', description: null, startsAt: at + 86_400_000, endsAt: at + 90_000_000, recurrence: 'weekly', recurrenceDays: [2, 4], timezone: 'Europe/Warsaw', recurrenceUntil: null },
          ],
        },
      }
    })
    renderPage()
    expect(await screen.findByText('DB upgrade')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('Nightly backup')).toBeInTheDocument()
    expect(screen.getByText('Upcoming')).toBeInTheDocument()
    expect(screen.getByText('Every Tue, Thu · Europe/Warsaw')).toBeInTheDocument()
  })

  it('marks a bar that only holds maintenance instead of calling it no data', async () => {
    const bars = stats.uptime.bars.map((bar, i) => (i === 27 ? { ...bar, checksTotal: 0, checksUp: 0, maintenanceChecks: 3 } : bar))
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.includes('/stats')) return { ...stats, uptime: { ...stats.uptime, bars } }
      if (path.includes('/dependencies')) return { dependsOnIds: [] }
      if (path === '/admin/monitors') return [monitor]
      return monitor
    })
    renderPage()
    const list = await screen.findByRole('list', { name: 'Uptime per 6 hours' })
    const labels = Array.from(list.children).map((item) => item.getAttribute('aria-label') ?? '')
    expect(labels[27]).toMatch(/: maintenance$/)
    expect(labels[0]).toMatch(/: no data$/)
  })

  it('says when no maintenance is scheduled', async () => {
    renderPage()
    expect(await screen.findByText('No maintenance scheduled.')).toBeInTheDocument()
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
