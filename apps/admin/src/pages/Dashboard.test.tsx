import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import DashboardPage from './Dashboard'

vi.mock('../api/client', () => ({
  api: { get: vi.fn() },
}))

const { dark } = vi.hoisted(() => ({ dark: { value: false } }))
vi.mock('../hooks/useDarkMode', () => ({
  useDarkMode: () => [dark.value, vi.fn()] as const,
}))

const monitors = [
  { id: 1, name: 'Checkout API', type: 'https', currentStatus: 'up', config: { url: 'https://shop.example.test' } },
  { id: 2, name: 'Edge router', type: 'ping', currentStatus: 'down', config: { host: '10.0.0.1' } },
  { id: 3, name: 'Resolver', type: 'dns', currentStatus: 'degraded', config: { hostname: 'example.test' } },
  { id: 4, name: 'Billing DB', type: 'sqlserver', currentStatus: 'pending', config: {} },
]

const incidents = [
  { id: 1, title: 'Checkout errors', status: 'identified', impact: 'major', startedAt: Date.UTC(2026, 8, 1) },
  { id: 2, title: 'Slow DNS', status: 'resolved', impact: 'minor', startedAt: Date.UTC(2026, 7, 1) },
  { id: 3, title: 'Search lag', status: 'monitoring', impact: 'minor', startedAt: Date.UTC(2026, 7, 2) },
]

function mockData(monitorList: unknown[], incidentList: unknown[] = []) {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/monitors') return monitorList
    if (path === '/admin/incidents') return incidentList
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
    dark.value = false
  })

  it('summarises monitor health, endpoints and active incidents', async () => {
    mockData(monitors, incidents)
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Partial Outage' })).toBeInTheDocument()
    expect(screen.getByText('4 monitors tracked · 1 operational · 1 down · 1 degraded')).toBeInTheDocument()
    expect(screen.getByText('25%')).toBeInTheDocument()
    expect(screen.getByText('1 of 4 operational')).toBeInTheDocument()
    expect(screen.getByText('2 incidents in progress.')).toBeInTheDocument()
    expect(screen.getByText('https://shop.example.test')).toBeInTheDocument()
    expect(screen.getByText('10.0.0.1')).toBeInTheDocument()
    expect(screen.getByText('example.test')).toBeInTheDocument()
    expect(screen.getByText('sqlserver')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Recent Activity' })).toBeInTheDocument()
    expect(screen.getByText('major impact · identified')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Manage Monitors' })).toHaveAttribute('href', '/admin/monitors')
    expect(screen.getByAltText('BetterStatusPage')).toHaveAttribute('src', '/admin/logo_light.png')
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

  it('shows empty states without monitors or incidents', async () => {
    dark.value = true
    mockData([])
    renderPage()

    expect(await screen.findByRole('heading', { name: 'No Monitors Yet' })).toBeInTheDocument()
    expect(screen.getByText('Add a monitor to start tracking uptime.')).toBeInTheDocument()
    expect(await screen.findByText('No active issues.')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Recent Activity' })).not.toBeInTheDocument()
    expect(screen.getByAltText('BetterStatusPage')).toHaveAttribute('src', '/admin/logo_dark.png')
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
})
