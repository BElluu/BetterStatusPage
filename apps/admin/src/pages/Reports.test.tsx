import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UptimeReport } from '@bsp/shared'
import { api } from '../api/client'
import { ToastProvider } from '../components/ui'
import ReportsPage from './Reports'

vi.mock('../api/client', () => ({ api: { get: vi.fn(), download: vi.fn() } }))

const report: UptimeReport = {
  from: '2026-03-01',
  to: '2026-03-30',
  retentionDays: 90,
  monitors: [
    { monitorId: 1, monitorName: 'API', checksTotal: 1000, checksUp: 999, uptimePct: 99.9, avgResponseMs: 123.4, incidents: 2 },
    { monitorId: 2, monitorName: 'Website', checksTotal: 0, checksUp: 0, uptimePct: null, avgResponseMs: null, incidents: 0 },
  ],
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><ToastProvider><ReportsPage /></ToastProvider></QueryClientProvider>)
}

describe('ReportsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockImplementation(async (path: string) => path.startsWith('/admin/monitors') ? [{ id: 1, name: 'API' }] : report)
    vi.mocked(api.download).mockResolvedValue(undefined)
  })

  it('shows the uptime of every monitor for the chosen range', async () => {
    renderPage()
    expect(await screen.findByText('99.900%')).toBeInTheDocument()
    expect(screen.getByText('123 ms')).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBe(2)
    const request = vi.mocked(api.get).mock.calls.map(([path]) => path).find((path) => path.startsWith('/admin/reports/uptime'))!
    const params = new URL(request, 'http://x').searchParams
    expect((Date.parse(params.get('to')!) - Date.parse(params.get('from')!)) / 86_400_000).toBe(29)
    expect(params.has('monitorId')).toBe(false)
  })

  it('filters by monitor and exports the daily and summary CSV for the same range', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('99.900%')

    await user.selectOptions(screen.getByLabelText('Monitor'), '1')
    await user.click(screen.getByRole('button', { name: 'Export daily CSV' }))
    await user.click(screen.getByRole('button', { name: 'Export summary CSV' }))

    const [daily, summary] = vi.mocked(api.download).mock.calls
    expect(daily![0]).toMatch(/^\/admin\/reports\/uptime\/export\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}&monitorId=1&granularity=day$/)
    expect(daily![1]).toMatch(/^uptime-daily-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/)
    expect(summary![0]).toMatch(/granularity=total$/)
    expect(summary![1]).toMatch(/^uptime-summary-/)
  })

  it('blocks an invalid range instead of requesting the report', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('99.900%')
    vi.mocked(api.get).mockClear()

    await user.clear(screen.getByLabelText('From'))
    expect(screen.getByText('Choose both dates.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export daily CSV' })).toBeDisabled()
    expect(vi.mocked(api.get).mock.calls.some(([path]) => path.startsWith('/admin/reports'))).toBe(false)
  })

  it('warns when the range reaches past the retained results', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('99.900%')
    await user.click(screen.getByRole('button', { name: 'Last 90 days' }))
    expect(screen.queryByText(/earlier days of this range have no data/)).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('From'), { target: { value: new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10) } })
    expect(await screen.findByText(/earlier days of this range have no data/)).toBeInTheDocument()
  })
})
