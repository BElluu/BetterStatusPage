import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Monitor } from '@bsp/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import MonitorsPage from './Monitors'
import { ToastProvider } from '@better-forge/ui'

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))

// The monitor form is covered by its own tests.
vi.mock('../components/monitors/MonitorFormModal', () => ({
  default: ({ monitor, initialType, onClose, onSaved }: { monitor: Monitor | null; initialType?: string; onClose: () => void; onSaved: () => void }) => (
    <div role="dialog" aria-label="Monitor form">
      <p>{monitor ? `Editing ${monitor.name}` : 'New monitor'}</p>
      {initialType && <p>{`Preselected ${initialType}`}</p>}
      <button onClick={onSaved}>Save monitor</button>
      <button onClick={onClose}>Close form</button>
    </div>
  ),
}))

class FakeEventSource {
  static instances: FakeEventSource[] = []
  listeners = new Map<string, Array<(event: MessageEvent) => void>>()
  onerror: (() => void) | null = null
  close = vi.fn()

  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(data) }))
  }
}

const HEALTH = { uptime24h: 99, avgResponseMs: 120, responseTrend: Array.from({ length: 24 }, (_, i) => 100 + i), failureRunSince: null, latencyRatio: null }

const monitors = [
  { id: 1, name: 'Checkout API', type: 'https', config: { url: 'https://checkout.example.test' }, intervalSecs: 60, currentStatus: 'up', activity: { maintenance: false, windows: [], incident: null }, lastCheckedAt: Date.UTC(2026, 8, 1, 12), tags: [{ label: 'prod', color: '#ff0000' }] },
  { id: 2, name: 'billing db', type: 'sqlserver', intervalSecs: 30, currentStatus: 'down', activity: { maintenance: false, windows: [], incident: null }, lastCheckedAt: null, tags: [{ label: 'prod', color: '#ff0000' }, { label: 'db', color: '#00ff00' }] },
  { id: 3, name: 'Deploy hook', type: 'webhook', intervalSecs: 300, currentStatus: 'pending', activity: { maintenance: false, windows: [], incident: null }, lastCheckedAt: null, tags: [] },
].map((m) => ({ ...m, health: HEALTH })) as unknown as Monitor[]

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><MemoryRouter><ToastProvider><MonitorsPage /></ToastProvider></MemoryRouter></QueryClientProvider>)
}

function names() {
  return screen.getAllByRole('row').slice(1).map((row) => row.querySelector('td a')?.textContent)
}

describe('MonitorsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/monitors') return monitors
      if (path === '/auth/session') return {}
      throw new Error(`Unexpected GET ${path}`)
    })
    vi.mocked(api.post).mockResolvedValue({})
    vi.mocked(api.delete).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('lists the worst status first and lets the columns re-sort', async () => {
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('Checkout API')).toBeInTheDocument()
    expect(screen.getByText('3 monitors')).toBeInTheDocument()
    expect(screen.getByText('https://checkout.example.test · every 60 s')).toBeInTheDocument()
    // Down, then pending, then operational.
    expect(names()).toEqual(['billing db', 'Deploy hook', 'Checkout API'])
    // Webhook monitors are push-based and cannot be checked on demand.
    expect(screen.getAllByTitle('Check now')).toHaveLength(2)

    expect(screen.getByRole('columnheader', { name: /^Status/ })).toHaveAttribute('aria-sort', 'ascending')
    await user.click(screen.getByRole('button', { name: /^Name/ }))
    expect(names()).toEqual(['billing db', 'Checkout API', 'Deploy hook'])
    expect(screen.getByRole('columnheader', { name: /^Name/ })).toHaveAttribute('aria-sort', 'ascending')
    await user.click(screen.getByRole('button', { name: /^Name/ }))
    expect(names()).toEqual(['Deploy hook', 'Checkout API', 'billing db'])
    expect(screen.getByRole('columnheader', { name: /^Name/ })).toHaveAttribute('aria-sort', 'descending')
    expect(screen.getByRole('columnheader', { name: /^Status/ })).not.toHaveAttribute('aria-sort')
  })

  it('keeps export and import in the header menu', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Checkout API')

    expect(screen.queryByRole('link', { name: 'Import YAML' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getByRole('menuitem', { name: 'Import YAML' })).toHaveAttribute('href', '/admin/import')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('searches by name, address and type and filters by status', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Checkout API')

    const statusGroup = screen.getByRole('group', { name: 'Filter by status' })
    expect(within(statusGroup).getByRole('button', { name: /^Down\s*1$/ })).toBeInTheDocument()
    expect(within(statusGroup).getByRole('button', { name: /^All\s*3$/ })).toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Search monitors' }), 'checkout.example')
    expect(names()).toEqual(['Checkout API'])
    await user.clear(screen.getByRole('searchbox', { name: 'Search monitors' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search monitors' }), 'sqlserver')
    expect(names()).toEqual(['billing db'])
    await user.clear(screen.getByRole('searchbox', { name: 'Search monitors' }))

    await user.click(within(statusGroup).getByRole('button', { name: /^Down/ }))
    expect(names()).toEqual(['billing db'])
    await user.click(within(statusGroup).getByRole('button', { name: /^Operational/ }))
    expect(names()).toEqual(['Checkout API'])

    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by type' }), 'sqlserver')
    expect(screen.getByText('No monitors match the filters.')).toBeInTheDocument()
  })

  it('shows the whole address and interval as a hint, since a long one is cut off in the row', async () => {
    const user = userEvent.setup()
    renderPage()
    const line = await screen.findByText('https://checkout.example.test · every 60 s')
    expect(line).toHaveAttribute('title', 'https://checkout.example.test · every 60 s')

    await user.click(screen.getByRole('button', { name: 'Compact rows' }))
    expect(screen.getByText('https://checkout.example.test · every 60 s')).toHaveAttribute('title', 'https://checkout.example.test · every 60 s')
  })

  it('puts the monitors that are slower than usual right after the degraded ones', async () => {
    const quiet = { maintenance: false, windows: [], incident: null }
    const slow = { latencyAlertSince: Date.now() - 60_000 }
    vi.mocked(api.get).mockResolvedValue([
      { ...monitors[0], id: 10, name: 'Fine', currentStatus: 'up' },
      { ...monitors[0], id: 11, name: 'Slow', currentStatus: 'up', activity: quiet, ...slow },
      { ...monitors[0], id: 12, name: 'Degraded', currentStatus: 'degraded' },
      { ...monitors[0], id: 13, name: 'Down', currentStatus: 'down' },
      { ...monitors[0], id: 14, name: 'Pending', currentStatus: 'pending' },
    ])
    renderPage()
    await screen.findByText('Fine')
    expect(names()).toEqual(['Down', 'Degraded', 'Slow', 'Pending', 'Fine'])
  })

  it('shows uptime, a response trend and how long a failing monitor has been down', async () => {
    vi.mocked(api.get).mockResolvedValue([
      { ...monitors[1], health: { ...HEALTH, uptime24h: 94.14, avgResponseMs: 48, failureRunSince: Date.now() - 14 * 60_000 } },
      { ...monitors[2], health: { ...HEALTH, uptime24h: null, avgResponseMs: null, responseTrend: Array.from({ length: 24 }, () => null) } },
    ])
    renderPage()

    const row = (await screen.findByText('billing db')).closest('tr')!
    expect(within(row).getByText('Down 14 min')).toBeInTheDocument()
    expect(within(row).getByText('94.1%')).toBeInTheDocument()
    expect(within(row).getByRole('img', { name: 'Response time, last 24 hours, average 48 ms' })).toBeInTheDocument()
    // No timed check: a dash for uptime and no chart.
    const quiet = screen.getByText('Deploy hook').closest('tr')!
    expect(within(quiet).queryByRole('img')).not.toBeInTheDocument()
    expect(within(quiet).getAllByText('—').length).toBeGreaterThan(0)
  })

  it('shows how many times slower than usual a monitor is instead of its status', async () => {
    vi.mocked(api.get).mockResolvedValue([
      { ...monitors[0], latencyAlertSince: Date.now() - 60_000, health: { ...HEALTH, latencyRatio: 3.14 } },
    ])
    renderPage()

    const row = (await screen.findByText('Checkout API')).closest('tr')!
    expect(within(row).getByText('Slower 3.1×')).toBeInTheDocument()
    expect(within(row).queryByText('Operational')).not.toBeInTheDocument()
  })

  it('switches to compact rows and remembers the choice', async () => {
    const user = userEvent.setup()
    const first = renderPage()
    await screen.findByText('Checkout API')

    const cells = () => screen.getAllByRole('row')[1]!.querySelector('td')!
    expect(screen.getByRole('button', { name: 'Comfortable rows' })).toHaveAttribute('aria-pressed', 'true')
    expect(cells()).toHaveClass('py-3')

    await user.click(screen.getByRole('button', { name: 'Compact rows' }))
    expect(screen.getByRole('button', { name: 'Compact rows' })).toHaveAttribute('aria-pressed', 'true')
    expect(cells()).toHaveClass('py-1.5')
    expect(localStorage.getItem('bsp.monitors.compact')).toBe('1')

    first.unmount()
    renderPage()
    await screen.findByText('Checkout API')
    expect(screen.getByRole('button', { name: 'Compact rows' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows when a monitor was last checked as a relative time', async () => {
    vi.mocked(api.get).mockResolvedValue([{ ...monitors[0], lastCheckedAt: Date.now() - 12_000 }])
    renderPage()
    expect(await screen.findByText('12 s ago')).toBeInTheDocument()
  })

  it('marks monitors in maintenance or with an open incident', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/monitors') {
        return [
          { ...monitors[0], activity: { maintenance: true, windows: [], incident: null } },
          { ...monitors[1], activity: { maintenance: false, windows: [], incident: 'critical' } },
          monitors[2],
        ]
      }
      if (path === '/auth/session') return {}
      throw new Error(`Unexpected GET ${path}`)
    })
    renderPage()
    expect(await screen.findByText('Maintenance')).toBeInTheDocument()
    expect(screen.getByText('Incident · critical')).toBeInTheDocument()
    expect(screen.getAllByText(/^Maintenance$|^Incident ·/)).toHaveLength(2)
  })

  it('shows the status visitors see when an open incident is worse than the checks', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/monitors') {
        return [
          { ...monitors[0], activity: { maintenance: false, windows: [], incident: 'major' } },
          { ...monitors[1], activity: { maintenance: false, windows: [], incident: 'minor' } },
        ]
      }
      if (path === '/auth/session') return {}
      throw new Error(`Unexpected GET ${path}`)
    })
    renderPage()
    expect(await screen.findByText('Down · incident')).toBeInTheDocument()
    // The incident never hides a worse check result.
    const table = within(screen.getByRole('table'))
    expect(table.getByText('Down')).toBeInTheDocument()
    expect(table.queryByText('Operational')).not.toBeInTheDocument()
  })

  it('filters by tag and clears the filter', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Checkout API')

    // The tag appears both in the filter bar and on the row; the filter bar comes first.
    await user.click(screen.getAllByRole('button', { name: 'db' })[0]!)
    expect(names()).toEqual(['billing db'])
    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(names()).toHaveLength(3)
  })

  it('applies live status updates from the event stream', async () => {
    renderPage()
    const row = (await screen.findByText('Checkout API')).closest('tr')!
    expect(within(row).getByText('Operational')).toBeInTheDocument()

    // A change of status also asks the server for the list again (it carries how long an outage has lasted), and the
    // server by then knows the monitor is down.
    const since = Date.now() - 330_000
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/monitors') return monitors.map((m) => (m.id === 1 ? { ...m, currentStatus: 'down', health: { ...HEALTH, failureRunSince: since } } : m))
      if (path === '/auth/session') return {}
      throw new Error(`Unexpected GET ${path}`)
    })
    act(() => FakeEventSource.instances[0]!.emit('monitor.status', { monitorId: 1, status: 'down', responseMs: null, checkedAt: Date.now() }))
    expect(await within(row).findByText('Down 5 min')).toBeInTheDocument()
  })

  it('checks the session before reconnecting a dropped stream', async () => {
    renderPage()
    await screen.findByText('Checkout API')
    vi.useFakeTimers()

    act(() => FakeEventSource.instances[0]!.onerror?.())
    expect(FakeEventSource.instances[0]!.close).toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(api.get).toHaveBeenCalledWith('/auth/session')
    expect(FakeEventSource.instances).toHaveLength(2)
  })

  it('triggers a check, opens the form and deletes after confirmation', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Checkout API')

    await user.click(screen.getByRole('button', { name: 'Check billing db now' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/monitors/2/check-now', {}))
    expect(await screen.findByText('Checked "billing db"')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add Monitor' }))
    expect(screen.getByText('New monitor')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close form' }))
    await user.click(screen.getByRole('button', { name: 'More actions for Checkout API' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.getByText('Editing Checkout API')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save monitor' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'More actions for Deploy hook' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(screen.getByText('Delete "Deploy hook"? This cannot be undone.')).toBeInTheDocument()
    await user.click(within(screen.getByRole('dialog', { name: 'Delete Monitor' })).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/monitors/3'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete Monitor' })).not.toBeInTheDocument())
    expect(screen.getByText('Deleted "Deploy hook"')).toBeInTheDocument()
  })

  it('keeps the delete dialog open while pending and reports failures', async () => {
    const user = userEvent.setup()
    let rejectDelete: (err: Error) => void = () => {}
    vi.mocked(api.delete).mockImplementation(() => new Promise((_resolve, reject) => { rejectDelete = reject }))
    vi.mocked(api.post).mockRejectedValue(new Error('timeout'))
    renderPage()
    await screen.findByText('Checkout API')

    await user.click(screen.getByRole('button', { name: 'Check Checkout API now' }))
    expect(await screen.findByText("Couldn't check \"Checkout API\": timeout")).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'More actions for Checkout API' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete Monitor' })
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(within(dialog).getByRole('button', { name: 'Deleting…' })).toBeDisabled()

    act(() => rejectDelete(new Error('in use')))
    expect(await screen.findByText("Couldn't delete monitor: in use")).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Delete Monitor' })).toBeInTheDocument()
  })

  it('shows an error state when monitors fail to load', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('boom'))
    renderPage()

    expect(await screen.findByText("Couldn't load monitors.")).toBeInTheDocument()
  })

  it('offers monitor type tiles without monitors and opens the form with that type', async () => {
    const user = userEvent.setup()
    vi.mocked(api.get).mockResolvedValue([])
    renderPage()

    const panel = await screen.findByRole('region', { name: 'What should we check first?' })
    expect(within(panel).getAllByRole('button').map((tile) => tile.textContent)).toEqual([
      expect.stringContaining('HTTPS'), expect.stringContaining('TLS certificate'), expect.stringContaining('Domain expiry'),
      expect.stringContaining('Ping / TCP'), expect.stringContaining('DNS'), expect.stringContaining('Mail server'), expect.stringContaining('SSH'),
      expect.stringContaining('Database'), expect.stringContaining('Redis'), expect.stringContaining('Docker'), expect.stringContaining('Webhook'),
    ])
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    await user.click(within(panel).getByRole('button', { name: /DNS/ }))
    expect(screen.getByText('Preselected dns')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close form' }))

    await user.click(screen.getByRole('button', { name: 'Add Monitor' }))
    expect(screen.queryByText(/Preselected/)).not.toBeInTheDocument()
  })

  it('lists monitors in collapsible groups, ungrouped last, and opens them all while filtering', async () => {
    const user = userEvent.setup()
    vi.mocked(api.get).mockResolvedValue([
      { ...monitors[0], group: 'Initech' },
      { ...monitors[1], group: 'Acme Corp' },
      { ...monitors[2], group: null },
    ])
    renderPage()
    await screen.findByText('Checkout API')

    const headers = screen.getAllByRole('button', { name: /^(Acme Corp|Initech|Ungrouped)/ })
    expect(headers.map((h) => h.textContent?.replace('expand_more', ''))).toEqual(['Acme Corp11 down', 'Initech1', 'Ungrouped1'])

    await user.click(headers[1]!)
    expect(screen.queryByText('Checkout API')).not.toBeInTheDocument()
    expect(screen.getByText('billing db')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Initech/ })).toHaveAttribute('aria-expanded', 'false')

    await user.type(screen.getByRole('searchbox', { name: 'Search monitors' }), 'checkout')
    expect(screen.getByText('Checkout API')).toBeInTheDocument()
  })

  it('keeps the table when no monitor matches the tag filter and can clear it', async () => {
    const user = userEvent.setup()
    vi.mocked(api.get).mockResolvedValue([
      { ...monitors[0], tags: [{ label: 'eu', color: '#ff0000' }] },
      { ...monitors[1], tags: [{ label: 'us', color: '#00ff00' }] },
    ])
    renderPage()
    await screen.findByText('Checkout API')

    const filterBar = screen.getByRole('group', { name: 'Filter by tag' })
    await user.click(within(filterBar).getByRole('button', { name: 'eu' }))
    await user.click(within(filterBar).getByRole('button', { name: 'us' }))
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
    expect(screen.getByText('No monitors match the filters.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear the filters' }))
    expect(screen.getByText('Checkout API')).toBeInTheDocument()
    expect(screen.queryByText('No monitors match the filters.')).not.toBeInTheDocument()
  })

  it('shows how long the TLS certificate of an HTTPS monitor is still valid', async () => {
    const day = 86_400_000
    vi.mocked(api.get).mockResolvedValueOnce([
      { ...monitors[0], config: { url: 'https://a.test', certExpiry: { enabled: true, warnDays: 14 } }, certExpiresAt: Date.now() + 5.5 * day },
      { ...monitors[0], id: 4, name: 'Old cert', config: { url: 'https://b.test' }, certExpiresAt: Date.now() - day },
    ])
    renderPage()

    expect(await screen.findByText('TLS 5 d')).toBeInTheDocument()
    expect(screen.getByText('TLS expired')).toBeInTheDocument()
  })

  it('shows no certificate validity for a monitor that ignores TLS errors', async () => {
    vi.mocked(api.get).mockResolvedValueOnce([
      { ...monitors[0], config: { url: 'https://a.test', ignoreTls: true }, certExpiresAt: Date.now() + 5 * 86_400_000 },
    ])
    renderPage()

    await screen.findByText(monitors[0]!.name)
    expect(screen.queryByText(/^TLS /)).not.toBeInTheDocument()
  })
})
