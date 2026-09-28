import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LayoutTree } from '@bsp/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getJSON } from './api'
import App from './App'

vi.mock('./api', () => ({ getJSON: vi.fn() }))

const { sse, dark, toggleDark, subscriptionOptions, subscriptionLink } = vi.hoisted(() => ({
  sse: { map: {} as Record<number, { status: string; responseMs: number | null; checkedAt: number }>, onChange: null as null | (() => void) },
  dark: { value: false },
  toggleDark: vi.fn(),
  subscriptionOptions: { value: { methods: [] as string[] } },
  subscriptionLink: { value: null as null | { mode: string; token: string } },
}))

vi.mock('./hooks/useSSE', () => ({
  useSSE: (onChange: () => void) => { sse.onChange = onChange; return sse.map },
}))
vi.mock('./hooks/useDarkMode', () => ({
  useDarkMode: () => [dark.value, toggleDark] as const,
}))

// The layout renderer and subscription dialogs have their own tests; the page only wires them up.
vi.mock('./components/PageRenderer', () => ({
  PageRenderer: ({ monitors, maintenanceMonitorIds, dependencyMap }: {
    monitors: Array<{ id: number; name: string; currentStatus: string }>
    maintenanceMonitorIds: Set<number>
    dependencyMap: Record<number, number[]>
  }) => (
    <ul aria-label="Rendered layout">
      {monitors.map((m) => (
        <li key={m.id}>
          {m.name}: {m.currentStatus}
          {maintenanceMonitorIds.has(m.id) ? ' (maintenance)' : ''}
          {dependencyMap[m.id] ? ` depends on ${dependencyMap[m.id]!.join(',')}` : ''}
        </li>
      ))}
    </ul>
  ),
}))
vi.mock('./components/Subscriptions', () => ({
  FEED_URL: '/api/v1/public/incidents.rss',
  useSubscriptionOptions: () => ({ data: subscriptionOptions.value }),
  readSubscriptionLink: () => subscriptionLink.value,
  clearSubscriptionLink: vi.fn(),
  SubscribeDialog: ({ onClose }: { onClose: () => void }) => <div role="dialog" aria-label="Subscribe"><button onClick={onClose}>Close subscribe</button></div>,
  SubscriptionLinkDialog: ({ onClose }: { onClose: () => void }) => <div role="dialog" aria-label="Subscription link"><button onClick={onClose}>Close link</button></div>,
}))

const monitors = [
  { id: 1, name: 'Checkout API', type: 'https', currentStatus: 'up' },
  { id: 2, name: 'Search', type: 'https', currentStatus: 'up' },
  { id: 3, name: 'Hidden', type: 'ping', currentStatus: 'down' },
]

const layout = {
  id: 'root', type: 'page',
  children: [
    { id: 'g', type: 'group', label: 'Core', children: [{ id: 'm1', type: 'monitor', monitorId: 1 }] },
    { id: 'm2', type: 'monitor', monitorId: 2 },
  ],
} as unknown as LayoutTree

interface Data {
  status: Record<string, unknown>
  layout: unknown
  incidents: unknown[]
}

let data: Data

function baseStatus(overrides: Record<string, unknown> = {}) {
  return { branding: null, monitors, activeIncidents: [], activeMaintenanceWindows: [], monitorDependencies: [], ...overrides }
}

function mockApi() {
  vi.mocked(getJSON).mockImplementation(async (path: string) => {
    if (path === '/api/v1/public/status') return data.status
    if (path === '/api/v1/public/layout') {
      if (data.layout === 'pending') return new Promise(() => {})
      return data.layout
    }
    if (path.startsWith('/api/v1/public/incidents')) return data.incidents
    throw new Error(`Unexpected GET ${path}`)
  })
}

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>)
}

describe('status App', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sse.map = {}
    dark.value = false
    subscriptionOptions.value = { methods: [] }
    subscriptionLink.value = null
    data = { status: baseStatus(), layout: { tree: layout, branding: null }, incidents: [] }
    mockApi()
  })

  it('reports all systems operational for the monitors placed in the layout', async () => {
    renderApp()

    expect(await screen.findByRole('heading', { name: 'All systems operational.' })).toBeInTheDocument()
    // The monitor that is not in the layout is neither counted nor able to turn the page red.
    expect(await screen.findByText('2 services monitored in real time.')).toBeInTheDocument()
    expect(screen.getByText('Checkout API: up')).toBeInTheDocument()
    expect(document.title).toBe('Status Page')
    expect(screen.getAllByAltText('Status Page')[0]).toHaveAttribute('src', '/logo_light.png')
    expect(getJSON).toHaveBeenCalledWith('/api/v1/public/status', { cache: 'no-cache' })
  })

  it('applies live SSE status and derives partial and major outages', async () => {
    sse.map = { 1: { status: 'down', responseMs: null, checkedAt: 1 } }
    const { unmount } = renderApp()
    expect(await screen.findByRole('heading', { name: 'Partial Outage.' })).toBeInTheDocument()
    expect(screen.getByText('Checkout API: down')).toBeInTheDocument()
    unmount()

    sse.map = { 1: { status: 'down', responseMs: null, checkedAt: 1 }, 2: { status: 'down', responseMs: null, checkedAt: 1 } }
    renderApp()
    expect(await screen.findByRole('heading', { name: 'Major Outage.' })).toBeInTheDocument()
  })

  it('shows degradation, maintenance banners and dependencies', async () => {
    data.status = baseStatus({
      monitors: [{ ...monitors[0], currentStatus: 'degraded' }, monitors[1]],
      activeMaintenanceWindows: [{ id: 5, name: 'DB upgrade', description: 'Short downtime', endsAt: Date.UTC(2026, 8, 2), monitorIds: [2] }],
      monitorDependencies: [{ dependentId: 1, dependsOnId: 2 }],
    })
    renderApp()

    expect(await screen.findByRole('heading', { name: 'Partial Degradation.' })).toBeInTheDocument()
    expect(screen.getByText('DB upgrade')).toBeInTheDocument()
    expect(screen.getByText('Short downtime')).toBeInTheDocument()
    expect(screen.getByText('Search: up (maintenance)')).toBeInTheDocument()
    expect(screen.getByText('Checkout API: degraded depends on 2')).toBeInTheDocument()
  })

  it('reports incidents in progress when the layout shows incidents', async () => {
    data.layout = { tree: { ...layout, children: [...layout.children, { id: 'i', type: 'incidents' }] }, branding: null }
    data.status = baseStatus({ activeIncidents: [{ id: 9, title: 'Checkout errors', status: 'investigating', impact: 'major', monitorIds: [], updates: [] }] })
    renderApp()

    expect(await screen.findByRole('heading', { name: 'Incidents in Progress.' })).toBeInTheDocument()
    expect(screen.getByText(/1 active incidents\./)).toBeInTheDocument()
  })

  it('says it is checking, not operational, while the status is still loading', async () => {
    data.layout = 'pending'
    renderApp()

    expect(await screen.findByRole('heading', { name: 'Checking…' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'All systems operational.' })).not.toBeInTheDocument()
    expect(screen.queryByText(/services monitored/)).not.toBeInTheDocument()
  })

  it('reports a failed status request instead of all systems operational', async () => {
    vi.mocked(getJSON).mockImplementation(async (path: string) => {
      if (path === '/api/v1/public/status') throw new Error('offline')
      if (path === '/api/v1/public/layout') return data.layout
      return []
    })
    renderApp()

    expect(await screen.findByRole('heading', { name: 'Unable to load status — retrying…' })).toBeInTheDocument()
  })

  it('does not call a page without services operational', async () => {
    data.layout = { tree: { id: 'root', type: 'page', children: [{ id: 't', type: 'text', markdown: 'Hi' }] }, branding: null }
    renderApp()

    expect(await screen.findByRole('heading', { name: 'No services to show yet.' })).toBeInTheDocument()
  })

  it('prompts to configure an empty layout', async () => {
    data.layout = { tree: { id: 'root', type: 'page', children: [] }, branding: null }
    renderApp()

    expect(await screen.findByText('This page has not been configured yet.')).toBeInTheDocument()
  })

  it('falls back to an events list with active and history tabs while the layout is unavailable', async () => {
    const user = userEvent.setup()
    data.layout = 'pending'
    data.status = baseStatus({ activeIncidents: [{ id: 9, title: 'Checkout errors', status: 'investigating', impact: 'major', startedAt: 1, monitorIds: [], updates: [] }] })
    data.incidents = [{ id: 8, title: 'DNS blip', status: 'resolved', impact: 'minor', startedAt: Date.UTC(2026, 7, 1), monitorIds: [], updates: [] }]
    renderApp()

    expect(await screen.findByRole('heading', { name: 'System Events' })).toBeInTheDocument()
    expect(screen.getByText('Checkout errors')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'History' }))
    expect(screen.getByText('DNS blip')).toBeInTheDocument()
    expect(screen.getByText('minor impact')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Active' }))
    expect(screen.getByText('Checkout errors')).toBeInTheDocument()
  })

  it('applies enabled branding: text logo, custom CSS and no dark-mode toggle', async () => {
    const branding = {
      enabled: 1, siteName: 'Acme Status', logoType: 'text', logoText: 'ACME', customCss: '.bsp-page { outline: 0 }',
      backgroundColor: '#fff', textColor: '#111', statusUpColor: '#0f0', statusDownColor: '#f00', statusDegradedColor: '#ff0',
    }
    data.layout = { tree: layout, branding }
    renderApp()

    expect(await screen.findAllByText('ACME')).toHaveLength(2)
    await waitFor(() => expect(document.title).toBe('Acme Status'))
    expect(document.querySelector('style')).toHaveTextContent('.bsp-page { outline: 0 }')
    expect(screen.queryByRole('button', { name: 'Toggle dark mode' })).not.toBeInTheDocument()
  })

  it('hides the page header when branding turns it off, even without custom branding', async () => {
    data.layout = { tree: layout, branding: { enabled: 0, showHero: 0 } }
    renderApp()

    expect(await screen.findByRole('list', { name: 'Rendered layout' })).toBeInTheDocument()
    expect(screen.queryByText('Real-time Network Status')).not.toBeInTheDocument()
    expect(screen.queryByText('2 services monitored in real time.')).not.toBeInTheDocument()
    // The overall status is still announced as the page heading.
    expect(await screen.findByRole('heading', { level: 1, name: 'All systems operational.' })).toHaveClass('sr-only')
  })

  it('toggles dark mode, offers subscriptions and links the RSS feed', async () => {
    const user = userEvent.setup()
    dark.value = true
    subscriptionOptions.value = { methods: ['email', 'rss'] }
    renderApp()

    await screen.findByRole('heading', { name: 'All systems operational.' })
    expect(screen.getAllByAltText('Status Page')[0]).toHaveAttribute('src', '/logo_dark.png')
    await user.click(screen.getByRole('button', { name: 'Toggle dark mode' }))
    expect(toggleDark).toHaveBeenCalled()

    expect(screen.getByRole('link', { name: /RSS feed/ })).toHaveAttribute('href', '/api/v1/public/incidents.rss')
    expect(document.head.querySelector('link[type="application/rss+xml"]')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: /Subscribe/ }))
    await user.click(screen.getByRole('button', { name: 'Close subscribe' }))
    expect(screen.queryByRole('dialog', { name: 'Subscribe' })).not.toBeInTheDocument()
  })

  it('opens the subscription link dialog from an e-mail link', async () => {
    const user = userEvent.setup()
    subscriptionLink.value = { mode: 'confirm', token: 'abc' }
    renderApp()

    expect(await screen.findByRole('dialog', { name: 'Subscription link' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close link' }))
    expect(screen.queryByRole('dialog', { name: 'Subscription link' })).not.toBeInTheDocument()
  })

  it('refetches status and incidents when the event stream reports an incident change', async () => {
    renderApp()
    await screen.findByRole('heading', { name: 'All systems operational.' })
    const before = vi.mocked(getJSON).mock.calls.length

    sse.onChange!()

    await waitFor(() => expect(vi.mocked(getJSON).mock.calls.length).toBeGreaterThanOrEqual(before + 2))
  })
})
