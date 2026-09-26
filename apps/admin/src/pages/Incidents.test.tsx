import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Incident } from '@bsp/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import IncidentsPage from './Incidents'

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))

const incidents = [
  {
    id: 1,
    title: 'Checkout errors',
    status: 'identified',
    impact: 'major',
    startedAt: Date.UTC(2026, 8, 1),
    monitorIds: [10],
    updates: [
      { id: 2, incidentId: 1, status: 'identified', body: 'Root cause found in the payment proxy.', postedAt: Date.UTC(2026, 8, 1, 12) },
      { id: 1, incidentId: 1, status: 'investigating', body: 'Looking into elevated errors.', postedAt: Date.UTC(2026, 8, 1, 11) },
    ],
  },
  { id: 2, title: 'DNS blip', status: 'resolved', impact: 'minor', startedAt: Date.UTC(2026, 7, 1), monitorIds: [], updates: [] },
] as unknown as Incident[]

let subscriptionsEnabled = true

function mockGets(list: Incident[] = incidents) {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/incidents') return list
    if (path === '/admin/monitors') return [{ id: 10, name: 'Checkout API' }, { id: 11, name: 'Search' }]
    if (path === '/admin/subscribers/settings') return { enabled: subscriptionsEnabled }
    throw new Error(`Unexpected GET ${path}`)
  })
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><IncidentsPage /></QueryClientProvider>)
}

describe('IncidentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    subscriptionsEnabled = true
    mockGets()
    vi.mocked(api.post).mockResolvedValue({})
    vi.mocked(api.delete).mockResolvedValue(undefined)
  })

  it('lists incidents with their counts', async () => {
    renderPage()

    expect(await screen.findByText('Checkout errors')).toBeInTheDocument()
    expect(screen.getByText('DNS blip')).toBeInTheDocument()
    expect(screen.getByText('1 active · 2 total')).toBeInTheDocument()
  })

  it('shows an empty state', async () => {
    mockGets([])
    renderPage()

    expect(await screen.findByText('No incidents reported. All systems operational.')).toBeInTheDocument()
  })

  it('expands an incident to show monitors and its update timeline', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByText('Checkout errors'))

    expect(await screen.findByText('Checkout API')).toBeInTheDocument()
    expect(screen.getByText('Root cause found in the payment proxy.')).toBeInTheDocument()
    expect(screen.getByText('Looking into elevated errors.')).toBeInTheDocument()

    await user.click(screen.getByText('Checkout errors'))
    expect(screen.queryByText('Root cause found in the payment proxy.')).not.toBeInTheDocument()
  })

  it('offers no update form for a resolved incident', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByText('DNS blip'))

    expect(screen.getByText('None linked')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Describe the current situation…')).not.toBeInTheDocument()
  })

  it('posts an update, optionally without notifying subscribers', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByText('Checkout errors'))
    // An empty update is ignored.
    await user.click(screen.getByRole('button', { name: 'Post Update' }))
    expect(api.post).not.toHaveBeenCalled()

    await user.type(screen.getByPlaceholderText('Describe the current situation…'), 'Fix deployed.')
    await user.selectOptions(screen.getByDisplayValue('Monitoring'), 'resolved')
    await user.click(await screen.findByRole('checkbox', { name: 'Notify subscribers' }))
    await user.click(screen.getByRole('button', { name: 'Post Update' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/incidents/1/updates', {
      body: 'Fix deployed.',
      status: 'resolved',
      notifySubscribers: false,
    }))
    await waitFor(() => expect(screen.getByPlaceholderText('Describe the current situation…')).toHaveValue(''))
    expect(screen.getByRole('checkbox', { name: 'Notify subscribers' })).toBeChecked()
  })

  it('shows an error and keeps the draft when posting an update fails', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Incident is locked'))
    renderPage()

    await user.click(await screen.findByText('Checkout errors'))
    await user.type(screen.getByPlaceholderText('Describe the current situation…'), 'Still looking.')
    await user.click(screen.getByRole('button', { name: 'Post Update' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Incident is locked')
    expect(screen.getByPlaceholderText('Describe the current situation…')).toHaveValue('Still looking.')
  })

  it('hides the notify option while subscriptions are disabled', async () => {
    const user = userEvent.setup()
    subscriptionsEnabled = false
    renderPage()

    await user.click(await screen.findByText('Checkout errors'))
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/subscribers/settings'))

    expect(screen.queryByRole('checkbox', { name: 'Notify subscribers' })).not.toBeInTheDocument()
  })

  it('creates an incident linked to monitors', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: /New Incident/ }))
    await user.type(screen.getByPlaceholderText('Service degradation'), 'Search is slow')
    await user.selectOptions(screen.getByDisplayValue('Investigating'), 'monitoring')
    await user.selectOptions(screen.getByDisplayValue('Minor'), 'critical')
    await user.click(await screen.findByRole('checkbox', { name: 'Search' }))
    await user.click(screen.getByRole('button', { name: 'Create Incident' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/incidents', {
      title: 'Search is slow',
      status: 'monitoring',
      impact: 'critical',
      monitorIds: [11],
      notifySubscribers: true,
    }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Create Incident' })).not.toBeInTheDocument())
  })

  it('requires a title before creating an incident', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: /New Incident/ }))
    await user.click(screen.getByRole('button', { name: 'Create Incident' }))

    expect(screen.getByPlaceholderText('Service degradation')).toBeInvalid()
    expect(api.post).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Create Incident' })).not.toBeInTheDocument()
  })

  it('shows an error when creating an incident fails', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Title too long'))
    renderPage()

    await user.click(screen.getByRole('button', { name: /New Incident/ }))
    await user.type(screen.getByPlaceholderText('Service degradation'), 'x')
    await user.click(screen.getByRole('button', { name: 'Create Incident' }))

    expect(await screen.findByText('Title too long')).toBeInTheDocument()
  })

  it('deletes an incident only after confirmation', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click((await screen.findAllByRole('button', { name: 'Delete' }))[1]!)
    expect(screen.getByText('Delete "DNS blip"? This cannot be undone.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.delete).not.toHaveBeenCalled()

    await user.click(screen.getAllByRole('button', { name: 'Delete' })[1]!)
    await user.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!)

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/incidents/2'))
    // Deleting from the row must not also expand it.
    expect(screen.queryByText('None linked')).not.toBeInTheDocument()
  })
})
