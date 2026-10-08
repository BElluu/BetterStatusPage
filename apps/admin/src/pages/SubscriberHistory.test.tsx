import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubscriberDelivery, SubscriberDeliveryList } from '@bsp/shared'
import { api } from '../api/client'
import { ToastProvider } from '../components/ui'
import SubscriberHistoryPage from './SubscriberHistory'

vi.mock('../api/client', () => ({ api: { get: vi.fn(), post: vi.fn() } }))

const delivery = (overrides: Partial<SubscriberDelivery> = {}): SubscriberDelivery => ({
  id: 1, subscriberId: 7, subscriberType: 'email', destination: 'reader@example.test', eventType: 'incident.created',
  subject: 'API errors', status: 'failed', attemptCount: 4, maxAttempts: 4, nextAttemptAt: null, lastError: 'mailbox full',
  deliveredAt: null, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000, ...overrides,
})

const list = (deliveries: SubscriberDelivery[], pages = 1): SubscriberDeliveryList =>
  ({ deliveries, total: deliveries.length, page: 1, limit: 20, pages })

function renderPage(url = '/admin/subscribers/history') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}><ToastProvider><SubscriberHistoryPage /></ToastProvider></MemoryRouter>
    </QueryClientProvider>,
  )
}

const deliveryCalls = () => vi.mocked(api.get).mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith('/admin/subscribers/deliveries'))

describe('SubscriberHistoryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue(list([delivery()]) as never)
    vi.mocked(api.post).mockResolvedValue(delivery({ status: 'pending' }) as never)
  })

  it('lists deliveries, links back to the subscribers and filters by status and event', async () => {
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByText('reader@example.test')).toBeInTheDocument()
    expect(screen.getByText('API errors')).toBeInTheDocument()
    expect(screen.getByText('4 / 4')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Subscribers/ })).toHaveAttribute('href', '/admin/subscribers')

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'failed')
    await waitFor(() => expect(deliveryCalls().at(-1)).toContain('status=failed'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Event' }), 'incident.resolved')
    await waitFor(() => expect(deliveryCalls().at(-1)).toContain('eventType=incident.resolved'))
  })

  it('shows the error of a failed delivery and retries it', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Show details for reader@example.test' }))
    expect(within(screen.getByRole('alert')).getByText('mailbox full')).toBeInTheDocument()
    expect(screen.getByText('Email to reader@example.test')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry now' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/subscribers/deliveries/1/retry', {}))
  })

  it('offers no retry for a delivered message and describes webhook calls', async () => {
    const user = userEvent.setup()
    vi.mocked(api.get).mockResolvedValue(list([delivery({
      status: 'delivered', lastError: null, subscriberType: 'webhook', destination: 'https://hooks.example.test/in', deliveredAt: 1_700_000_050_000, attemptCount: 1,
    })]) as never)
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Show details for https://hooks.example.test/in' }))
    expect(screen.getByText('Webhook to https://hooks.example.test/in with X-BSP-Event: incident.created')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry now' })).not.toBeInTheDocument()
  })

  it('narrows to one subscriber from the link and clears it from the chip', async () => {
    const user = userEvent.setup()
    renderPage('/admin/subscribers/history?subscriberId=7')
    expect(await screen.findByRole('button', { name: 'Show all subscribers' })).toBeInTheDocument()
    expect(deliveryCalls().at(-1)).toContain('subscriberId=7')

    await user.click(screen.getByRole('button', { name: 'Show all subscribers' }))
    await waitFor(() => expect(deliveryCalls().at(-1)).not.toContain('subscriberId'))
  })

  it('explains an empty history and a filter with no matches', async () => {
    const user = userEvent.setup()
    vi.mocked(api.get).mockResolvedValue(list([]) as never)
    renderPage()
    expect(await screen.findByText('No deliveries yet')).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'pending')
    expect(await screen.findByText('No deliveries match these filters.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear the filters' }))
    expect(await screen.findByText('No deliveries yet')).toBeInTheDocument()
  })

  it('shows a retryable error', async () => {
    const user = userEvent.setup()
    vi.mocked(api.get).mockRejectedValueOnce(new Error('down'))
    renderPage()
    expect(await screen.findByText('Could not load deliveries.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Try again/ }))
    expect(await screen.findByText('reader@example.test')).toBeInTheDocument()
  })
})
