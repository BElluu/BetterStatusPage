import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, getCurrentUser } from '../api/client'
import DashboardPage from './Dashboard'

vi.mock('../api/client', () => ({
  api: { get: vi.fn() },
  getCurrentUser: vi.fn(),
}))


const HEALTH = { uptime24h: 99, avgResponseMs: 120, responseTrend: Array.from({ length: 24 }, (_, i) => 100 + i), failureRunSince: null, latencyRatio: null }

const monitors = [
  { id: 1, name: 'Checkout API', type: 'https', currentStatus: 'up', activity: { maintenance: false, windows: [], incident: null }, config: { url: 'https://shop.example.test' } },
  { id: 2, name: 'Edge router', type: 'ping', currentStatus: 'down', activity: { maintenance: false, windows: [], incident: null }, config: { host: '10.0.0.1' } },
  { id: 3, name: 'Resolver', type: 'dns', currentStatus: 'degraded', activity: { maintenance: false, windows: [], incident: null }, config: { hostname: 'example.test' } },
  { id: 4, name: 'Billing DB', type: 'sqlserver', currentStatus: 'pending', activity: { maintenance: false, windows: [], incident: null }, config: {} },
].map((m) => ({ ...m, health: HEALTH }))

const incidents = [
  { id: 1, title: 'Checkout errors', status: 'identified', impact: 'major', startedAt: Date.UTC(2026, 8, 1) },
  { id: 2, title: 'Slow DNS', status: 'resolved', impact: 'minor', startedAt: Date.UTC(2026, 7, 1) },
  { id: 3, title: 'Search lag', status: 'monitoring', impact: 'minor', startedAt: Date.UTC(2026, 7, 2) },
]

function mockData(monitorList: unknown[], incidentList: unknown[] = [], maintenanceList: unknown[] = []) {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/monitors') return monitorList
    if (path === '/admin/incidents') return incidentList
    if (path === '/admin/maintenance') return maintenanceList
    if (path === '/admin/system-health/update') return { version: '0.2.0', update: { version: '0.2.1', url: 'https://github.com/BElluu/BetterStatusPage/releases/tag/v0.2.1' } }
    throw new Error(`Unexpected GET ${path}`)
  })
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><MemoryRouter><DashboardPage /></MemoryRouter></QueryClientProvider>)
}

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCurrentUser).mockReturnValue({ userId: 1, email: 'op@example.test', role: 'operator', mustChangePassword: false, twoFactorEnabled: false })
  })

  it('summarises monitor health, endpoints and active incidents', async () => {
    mockData(monitors, incidents)
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Partial Outage' })).toBeInTheDocument()
    expect(screen.getByText('4 monitors tracked · 1 operational · 1 down · 1 degraded')).toBeInTheDocument()
    // The worst monitors come first, under "Needs attention".
    const monitorLinks = screen.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/admin/monitors/'))
    expect(monitorLinks.map((a) => a.querySelector('h4')?.textContent)).toEqual(['Edge router', 'Resolver', 'Billing DB', 'Checkout API'])
    expect(screen.getByRole('heading', { name: /^Needs attention/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^Operational/ })).toBeInTheDocument()
    const open = within(screen.getByRole('region', { name: 'Open incidents' }))
    expect(open.getByText('Checkout errors')).toBeInTheDocument()
    expect(open.getByText('Search lag')).toBeInTheDocument()
    expect(open.queryByText('Slow DNS')).not.toBeInTheDocument()
    expect(open.getByRole('link', { name: 'View all' })).toHaveAttribute('href', '/admin/incidents')
    expect(screen.getByText(/^Updated /)).toBeInTheDocument()
    expect(screen.getByText('https://shop.example.test')).toBeInTheDocument()
    expect(screen.getByText('10.0.0.1')).toBeInTheDocument()
    expect(screen.getByText('example.test')).toBeInTheDocument()
    expect(screen.getByText('sqlserver')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Recent Activity' })).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Recent Activity' })).getAllByText(/impact · identified$/)[0]).toHaveTextContent('major impact · identified')
    expect(screen.getByRole('link', { name: 'Manage Monitors' })).toHaveAttribute('href', '/admin/monitors')
    expect(screen.getByRole('link', { name: /Checkout API/ })).toHaveAttribute('href', '/admin/monitors/1')
  })

  it('lists upcoming and running maintenance with the monitors it covers', async () => {
    const hour = 3_600_000
    mockData(monitors, [], [
      { id: 1, name: 'Database upgrade', monitorIds: [], occurrence: { startsAt: Date.now() + hour, endsAt: Date.now() + 2 * hour } },
      { id: 2, name: 'Router swap', monitorIds: [2, 3], occurrence: { startsAt: Date.now() - hour, endsAt: Date.now() + hour } },
      { id: 3, name: 'Finished window', monitorIds: [], occurrence: { startsAt: Date.now() - 3 * hour, endsAt: Date.now() - 2 * hour } },
    ])
    renderPage()

    const card = within(await screen.findByRole('region', { name: 'Upcoming maintenance' }))
    expect(card.getByText('Database upgrade')).toBeInTheDocument()
    expect(card.getByText(/All monitors$/)).toBeInTheDocument()
    expect(card.getByText(/In progress until .* · 2 monitors$/)).toBeInTheDocument()
    expect(card.queryByText('Finished window')).not.toBeInTheDocument()
  })

  it('says so when no maintenance is planned', async () => {
    mockData(monitors)
    renderPage()
    await screen.findByRole('heading', { name: 'Partial Outage' })
    expect(await screen.findByText('No maintenance planned.')).toBeInTheDocument()
  })

  it.each([
    [[{ ...monitors[0] }], 'All Systems Operational'],
    [[{ ...monitors[1] }], 'Major Outage Detected'],
    [[monitors[0], monitors[2]], 'Partial Degradation'],
  ])('derives the global status from monitor states (%#)', async (list, heading) => {
    mockData(list)
    renderPage()

    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument()
  })

  it('counts monitors by the status visitors see, with open incidents applied', async () => {
    mockData([
      { ...monitors[0], activity: { maintenance: false, windows: [], incident: 'major' } },
      monitors[2],
    ])
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Partial Outage' })).toBeInTheDocument()
    expect(screen.getByText('2 monitors tracked · 0 operational · 1 down · 1 degraded')).toBeInTheDocument()
    expect(screen.getByText('Down · incident')).toBeInTheDocument()
  })

  it('shows how long a monitor has been failing, its response time and the 24 hour numbers', async () => {
    mockData([
      monitors[0],
      { ...monitors[1], health: { ...HEALTH, uptime24h: 91, avgResponseMs: 300, failureRunSince: Date.now() - 14 * 60_000 } },
    ])
    renderPage()

    expect(await screen.findByText('Down 14 min')).toBeInTheDocument()
    // An operational monitor shows its average response time in place of the status label.
    expect(screen.getByText('120 ms')).toBeInTheDocument()
    expect(screen.getByText("uptime, 24 h").previousElementSibling).toHaveTextContent("95%")
    expect(screen.getByText('avg response').previousElementSibling).toHaveTextContent('210 ms')
    expect(screen.getAllByRole('img', { name: /^Response time, last 24 hours, average/ })).toHaveLength(2)
  })

  it('lists a monitor that is slower than usual under Needs attention with how many times slower', async () => {
    mockData([
      { ...monitors[0], latencyAlertSince: Date.now() - 60_000, health: { ...HEALTH, latencyRatio: 3.14 } },
      { ...monitors[2], id: 9, name: 'Quiet', currentStatus: 'up', latencyAlertSince: null },
    ])
    renderPage()

    const heading = await screen.findByRole('heading', { name: /^Needs attention · 1/ })
    expect(heading).toBeInTheDocument()
    const chip = screen.getByText('Slower 3.1×')
    expect(chip).toHaveAttribute('title', expect.stringContaining('3.1×'))
    // The chip stands in for the response time chip of the same monitor.
    expect(within(screen.getByText('Checkout API').closest('a')!).queryByText('120 ms')).not.toBeInTheDocument()
  })

  it('cuts a long operational list and links to all monitors', async () => {
    mockData(Array.from({ length: 11 }, (_, i) => ({ ...monitors[0], id: 100 + i, name: `Service ${i}` })))
    renderPage()

    expect(await screen.findByRole('heading', { name: /^All monitors · 11/ })).toBeInTheDocument()
    expect(screen.getByText('Service 7')).toBeInTheDocument()
    expect(screen.queryByText('Service 8')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /\+ 3 more/ })).toHaveAttribute('href', '/admin/monitors')
  })

  it('shows empty states without monitors or incidents', async () => {
    mockData([])
    renderPage()

    expect(await screen.findByRole('heading', { name: 'No Monitors Yet' })).toBeInTheDocument()
    expect(screen.getByText('Add your first monitor to start tracking uptime and show it on your status page.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add your first monitor' })).toHaveAttribute('href', '/admin/monitors')
    expect(await screen.findByText('No active issues.')).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(3)
    expect(screen.queryByRole('heading', { name: 'Recent Activity' })).not.toBeInTheDocument()
  })

  it('shows a loading state instead of empty copy while monitors load', () => {
    vi.mocked(api.get).mockImplementation(() => new Promise(() => {}))
    renderPage()

    expect(screen.getByRole('status')).toHaveTextContent('Loading monitors…')
    expect(screen.queryByText('No Monitors Yet')).not.toBeInTheDocument()
    expect(screen.queryByText('No active issues.')).not.toBeInTheDocument()
  })

  it('shows an error state with retry when monitors fail to load', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('boom'))
    renderPage()

    expect(await screen.findByText("Couldn't load monitors.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument()
    expect(screen.queryByText('No Monitors Yet')).not.toBeInTheDocument()
  })

  it('tells administrators, and only them, that a newer version is available', async () => {
    mockData(monitors, incidents)
    vi.mocked(getCurrentUser).mockReturnValue({ userId: 1, email: 'admin@example.test', role: 'admin', mustChangePassword: false, twoFactorEnabled: false })
    const view = renderPage()
    expect(await screen.findByRole('link', { name: /Version 0\.2\.1 is available/ })).toHaveAttribute('href', 'https://github.com/BElluu/BetterStatusPage/releases/tag/v0.2.1')
    view.unmount()

    vi.mocked(getCurrentUser).mockReturnValue({ userId: 2, email: 'op@example.test', role: 'operator', mustChangePassword: false, twoFactorEnabled: false })
    renderPage()
    await screen.findByText('Checkout API')
    expect(screen.queryByRole('link', { name: /is available/ })).not.toBeInTheDocument()
  })
})
