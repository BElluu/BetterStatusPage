import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Monitor } from '@bsp/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import MonitorsPage from './Monitors'

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))

// The monitor form is covered by its own tests.
vi.mock('../components/monitors/MonitorFormModal', () => ({
  default: ({ monitor, onClose, onSaved }: { monitor: Monitor | null; onClose: () => void; onSaved: () => void }) => (
    <div role="dialog" aria-label="Monitor form">
      <p>{monitor ? `Editing ${monitor.name}` : 'New monitor'}</p>
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

const monitors = [
  { id: 1, name: 'Checkout API', type: 'https', intervalSecs: 60, currentStatus: 'up', lastCheckedAt: Date.UTC(2026, 8, 1, 12), tags: [{ label: 'prod', color: '#ff0000' }] },
  { id: 2, name: 'billing db', type: 'sqlserver', intervalSecs: 30, currentStatus: 'down', lastCheckedAt: null, tags: [{ label: 'prod', color: '#ff0000' }, { label: 'db', color: '#00ff00' }] },
  { id: 3, name: 'Deploy hook', type: 'webhook', intervalSecs: 300, currentStatus: 'pending', lastCheckedAt: null, tags: [] },
] as unknown as Monitor[]

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><MonitorsPage /></QueryClientProvider>)
}

function names() {
  return screen.getAllByRole('row').slice(1).map((row) => row.querySelector('td div')?.textContent)
}

describe('MonitorsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('lists monitors sorted by name and toggles the sort direction', async () => {
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('Checkout API')).toBeInTheDocument()
    expect(screen.getByText('3 monitors · 15s refresh')).toBeInTheDocument()
    expect(names()).toEqual(['billing db', 'Checkout API', 'Deploy hook'])
    // Webhook monitors are push-based and cannot be checked on demand.
    expect(screen.getAllByTitle('Check now')).toHaveLength(2)

    await user.click(screen.getByRole('columnheader', { name: /^Name/ }))
    expect(names()).toEqual(['Deploy hook', 'Checkout API', 'billing db'])
    await user.click(screen.getByRole('columnheader', { name: 'Interval' }))
    expect(names()).toEqual(['billing db', 'Checkout API', 'Deploy hook'])
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

    act(() => FakeEventSource.instances[0]!.emit('monitor.status', { monitorId: 1, status: 'down', responseMs: null, checkedAt: Date.now() }))
    expect(await within(row).findByText('Down')).toBeInTheDocument()
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

    await user.click(screen.getAllByTitle('Check now')[0]!)
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/monitors/2/check-now', {}))

    await user.click(screen.getByRole('button', { name: '+ Add Monitor' }))
    expect(screen.getByText('New monitor')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close form' }))
    await user.click(screen.getAllByTitle('Edit')[1]!)
    expect(screen.getByText('Editing Checkout API')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save monitor' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getAllByTitle('Delete')[2]!)
    expect(screen.getByText('Delete "Deploy hook"? This cannot be undone.')).toBeInTheDocument()
    await user.click(within(screen.getByRole('dialog', { name: 'Delete Monitor' })).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/monitors/3'))
  })

  it('shows an empty state without monitors', async () => {
    vi.mocked(api.get).mockResolvedValue([])
    renderPage()

    expect(await screen.findByText('No monitors yet. Click "+ Add Monitor" to create one.')).toBeInTheDocument()
  })

  it('shows how long the TLS certificate of an HTTPS monitor is still valid', async () => {
    const day = 86_400_000
    vi.mocked(api.get).mockResolvedValueOnce([
      { ...monitors[0], config: { url: 'https://a.test', certExpiry: { enabled: true, warnDays: 14 } }, certExpiresAt: Date.now() + 5.5 * day },
      { ...monitors[0], id: 4, name: 'Old cert', config: { url: 'https://b.test' }, certExpiresAt: Date.now() - day },
    ])
    renderPage()

    expect(await screen.findByText('TLS certificate: 5 days left')).toBeInTheDocument()
    expect(screen.getByText('TLS certificate expired')).toBeInTheDocument()
  })
})
