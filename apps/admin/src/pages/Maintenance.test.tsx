import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import MaintenancePage, { DateTimeInput } from './Maintenance'
import { ToastProvider } from '../components/ui'

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

describe('maintenance date and time input', () => {
  it('updates the date, hour, and minute without changing the local datetime format', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <DateTimeInput label="Starts At" value="2026-07-15T09:05" onChange={onChange} />,
    )

    fireEvent.change(screen.getByLabelText('Starts At — YYYY-MM-DD'), {
      target: { value: '2026-07-20' },
    })
    expect(onChange).toHaveBeenLastCalledWith('2026-07-20T09:05')

    rerender(<DateTimeInput label="Starts At" value="2026-07-20T09:05" onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Starts At — HH'), { target: { value: '17' } })
    expect(onChange).toHaveBeenLastCalledWith('2026-07-20T17:05')

    rerender(<DateTimeInput label="Starts At" value="2026-07-20T17:05" onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Starts At — MM'), { target: { value: '42' } })
    expect(onChange).toHaveBeenLastCalledWith('2026-07-20T17:42')
  })
})

const HOUR = 60 * 60 * 1000

function windows() {
  const now = Date.now()
  return [
    { id: 1, name: 'DB upgrade', description: 'Primary failover', startsAt: now - HOUR, endsAt: now + 90 * 60 * 1000, monitorIds: [10, 99] },
    { id: 2, name: 'Network work', description: null, startsAt: now + 2 * HOUR, endsAt: now + 4 * HOUR, monitorIds: [] },
    { id: 3, name: 'Old patching', description: null, startsAt: now - 5 * HOUR, endsAt: now - 5 * HOUR + 45 * 60 * 1000, monitorIds: [] },
  ]
}

function mockGets(list: unknown[] = windows()) {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/maintenance') return list
    if (path === '/admin/monitors') return [{ id: 10, name: 'Checkout API', type: 'https' }, { id: 11, name: 'Search', type: 'https' }]
    if (path === '/admin/subscribers/settings') return { enabled: true }
    throw new Error(`Unexpected GET ${path}`)
  })
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><ToastProvider><MaintenancePage /></ToastProvider></QueryClientProvider>)
}

describe('MaintenancePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGets()
    vi.mocked(api.post).mockResolvedValue({})
    vi.mocked(api.patch).mockResolvedValue({})
    vi.mocked(api.delete).mockResolvedValue(undefined)
  })

  it('splits windows into active, upcoming and past tabs', async () => {
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('DB upgrade')).toBeInTheDocument()
    expect(screen.getByText('1 active · 1 upcoming · 1 past')).toBeInTheDocument()
    expect(screen.getByText('ACTIVE · 1h 30m remaining')).toBeInTheDocument()
    expect(screen.getByText('Primary failover')).toBeInTheDocument()
    expect(await screen.findByText('Checkout API')).toBeInTheDocument()
    expect(screen.getByText('#99')).toBeInTheDocument()
    expect(screen.getByText('(2h 30m)')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^upcoming/ }))
    expect(screen.getByText('Network work')).toBeInTheDocument()
    expect(screen.getByText('All monitors')).toBeInTheDocument()
    expect(screen.getByText('(2h)')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^past/ }))
    expect(screen.getByText('Old patching')).toBeInTheDocument()
    expect(screen.getByText('(45m)')).toBeInTheDocument()
  })

  it('shows empty states per tab', async () => {
    const user = userEvent.setup()
    mockGets([])
    renderPage()

    expect(await screen.findByText('No active maintenance windows')).toBeInTheDocument()
    expect(screen.queryByText(/All systems running normally/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'upcoming' }))
    expect(screen.getByText('No upcoming maintenance scheduled')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'past' }))
    expect(screen.getByText('No past maintenance windows')).toBeInTheDocument()
  })

  it('shows loading and error states instead of empty copy', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('boom'))
    renderPage()

    expect(screen.getByText('Loading maintenance windows…')).toBeInTheDocument()
    expect(await screen.findByText("Couldn't load maintenance windows.")).toBeInTheDocument()
    expect(screen.queryByText('No active maintenance windows')).not.toBeInTheDocument()
  })

  it('moves a window from upcoming to active as time passes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const now = Date.now()
      mockGets([{ id: 5, name: 'Soon', description: null, startsAt: now + 20_000, endsAt: now + HOUR, monitorIds: [] }])
      renderPage()

      expect(await screen.findByText('0 active · 1 upcoming · 0 past')).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
      expect(screen.getByText('1 active · 0 upcoming · 0 past')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('schedules a window for selected monitors without notifying subscribers', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: /Schedule Maintenance/ }))
    expect(screen.getByText('No monitors selected — notifications will not be suppressed.')).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('Scheduled database maintenance'), 'Kernel patch')
    await user.type(screen.getByPlaceholderText('Brief description visible on the status page…'), '  ')
    await user.click(await screen.findByRole('checkbox', { name: /^Search/ }))
    await user.click(await screen.findByRole('checkbox', { name: 'Notify subscribers' }))
    await user.click(screen.getByRole('button', { name: 'Schedule' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/maintenance', expect.objectContaining({
      name: 'Kernel patch', description: null, monitorIds: [11], notifySubscribers: false,
    })))
    const payload = vi.mocked(api.post).mock.calls[0]![1] as { startsAt: number; endsAt: number }
    expect(payload.endsAt - payload.startsAt).toBe(2 * HOUR)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Schedule' })).not.toBeInTheDocument())
  })

  it('rejects an end time before the start and reports save failures', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockRejectedValueOnce(new Error('boom'))
    renderPage()

    await user.click(screen.getByRole('button', { name: /Schedule Maintenance/ }))
    await user.type(screen.getByPlaceholderText('Scheduled database maintenance'), 'Oops')
    const endDate = screen.getByLabelText('Ends At — YYYY-MM-DD') as HTMLInputElement
    fireEvent.change(endDate, { target: { value: '2020-01-01' } })
    await user.click(screen.getByRole('button', { name: 'Schedule' }))
    expect(screen.getByText('End time must be after start time.')).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()

    fireEvent.change(endDate, { target: { value: '2999-01-01' } })
    await user.click(screen.getByRole('checkbox', { name: 'All monitors' }))
    await user.click(screen.getByRole('button', { name: 'Schedule' }))
    expect(await screen.findByText('Failed to save. Please try again.')).toBeInTheDocument()
    expect(api.post).toHaveBeenCalledWith('/admin/maintenance', expect.objectContaining({ monitorIds: [] }))

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Schedule' })).not.toBeInTheDocument()
  })

  it('edits an existing window', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Edit DB upgrade' }))
    expect(screen.getByRole('heading', { name: 'Edit Maintenance Window' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Notify subscribers' })).not.toBeInTheDocument()
    const name = screen.getByDisplayValue('DB upgrade')
    await user.clear(name)
    await user.type(name, 'DB upgrade v2')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/maintenance/1', expect.objectContaining({
      name: 'DB upgrade v2', description: 'Primary failover', monitorIds: [10, 99],
    })))
  })

  it('ends an active window early and deletes after confirmation', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'End now' }))
    const endDialog = screen.getByRole('dialog', { name: 'End maintenance early' })
    await user.click(within(endDialog).getByRole('button', { name: 'End now' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/maintenance/1', { endsAt: expect.any(Number) }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'End maintenance early' })).not.toBeInTheDocument())
    expect(screen.getByText('Ended "DB upgrade"')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete DB upgrade' }))
    expect(screen.getByText('Delete "DB upgrade"? This cannot be undone.')).toBeInTheDocument()
    await user.click(within(screen.getByRole('dialog', { name: 'Delete maintenance window' })).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/maintenance/1'))
  })

  it('keeps the end-early dialog open and reports a failure', async () => {
    const user = userEvent.setup()
    vi.mocked(api.patch).mockRejectedValueOnce(new Error('Window already ended'))
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'End now' }))
    const endDialog = screen.getByRole('dialog', { name: 'End maintenance early' })
    await user.click(within(endDialog).getByRole('button', { name: 'End now' }))

    expect(await screen.findByText("Couldn't end maintenance: Window already ended")).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'End maintenance early' })).toBeInTheDocument()
  })
})
