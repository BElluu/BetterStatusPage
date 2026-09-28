import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SUBSCRIBER_EVENT_TYPES, subscriptionMethodStatuses, type AdminSubscriptionSettings } from '@bsp/shared'
import { api } from '../api/client'
import SubscribersPage from './Subscribers'

vi.mock('../api/client', () => ({ api: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } }))

const base = {
  enabled: true,
  allowEmail: true,
  allowWebhook: true,
  allowSlack: true,
  allowedEvents: [...SUBSCRIBER_EVENT_TYPES],
  allowComponentScope: false,
  rssEnabled: false,
  apiEnabled: false,
}

function settings(overrides: Partial<AdminSubscriptionSettings> = {}): AdminSubscriptionSettings {
  const merged = { ...base, ...overrides }
  return {
    ...merged,
    updatedAt: 1,
    smtpConfigured: false,
    publicUrl: '',
    methods: subscriptionMethodStatuses(merged, { smtpConfigured: false, publicUrl: '' }),
    ...overrides,
  }
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><SubscribersPage /></MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('SubscribersPage methods', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockImplementation(async (path: string) => (
      path === '/admin/subscribers/settings'
        ? settings()
        : path === '/admin/monitors' ? [] : { subscribers: [], stats: { total: 0, active: 0, pending: 0, unsubscribed: 0, disabled: 0 }, total: 0, page: 1, limit: 25, pages: 0 }
    ) as never)
  })

  it('explains why email and webhook are hidden while Slack is offered', async () => {
    renderPage()
    const email = await screen.findByTestId('method-email')
    expect(within(email).getByText('Not available')).toBeInTheDocument()
    expect(within(email).getByText(/SMTP is not configured/)).toBeInTheDocument()
    expect(within(email).getByText(/in the server environment/)).toBeInTheDocument()
    expect(within(screen.getByTestId('method-webhook')).getByText('Not available')).toBeInTheDocument()
    expect(within(screen.getByTestId('method-slack')).getByText('Offered to visitors')).toBeInTheDocument()
    expect(within(screen.getByTestId('method-rss')).getByText('Off')).toBeInTheDocument()
    expect(screen.getByText('Visitors will choose from: Slack.')).toBeInTheDocument()
  })

  it('updates what visitors are offered as soon as a method is toggled', async () => {
    const user = userEvent.setup()
    renderPage()
    const rss = await screen.findByTestId('method-rss')
    await user.click(within(rss).getByRole('switch', { name: 'Enable RSS / Atom' }))
    expect(within(rss).getByText('Offered to visitors')).toBeInTheDocument()
    expect(screen.getByText('Visitors will choose from: Slack, RSS / Atom.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled()
  })
})

describe('SubscribersPage table', () => {
  const subscriber = {
    id: 7, type: 'email', email: 'reader@example.test', webhookUrl: null, webhookMethod: null, webhookHeaderNames: [],
    notifyOnFailure: false, status: 'active', events: [...SUBSCRIBER_EVENT_TYPES], monitorIds: [], tags: [],
    lastNotifiedAt: null, lastError: null, consecutiveFailures: 0, createdAt: 1,
  }
  const list = (pages = 2) => ({ subscribers: [subscriber], stats: { total: 1, active: 1, pending: 0, unsubscribed: 0, disabled: 0 }, total: 1, page: 1, limit: 25, pages })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockImplementation(async (path: string) => (
      path === '/admin/subscribers/settings' ? settings() : path === '/admin/monitors' ? [] : list()
    ) as never)
    vi.mocked(api.delete).mockResolvedValue(undefined as never)
  })

  const subscriberCalls = () => vi.mocked(api.get).mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith('/admin/subscribers?'))

  it('debounces search, pages with the shared pagination and confirms deletes', async () => {
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByText('reader@example.test')).toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Search subscribers' }), 'rea')
    await waitFor(() => expect(subscriberCalls().some((path) => path.includes('search=rea'))).toBe(true))
    expect(subscriberCalls().filter((path) => /search=r(&|$)|search=re(&|$)/.test(path))).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(subscriberCalls().at(-1)).toContain('page=2'))

    await user.click(screen.getByRole('button', { name: 'Delete reader@example.test' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/subscribers/7'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('uses a pressed segmented control for the status filter', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('reader@example.test')
    expect(screen.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: /^Paused/ }))
    expect(screen.getByRole('button', { name: /^Paused/ })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(subscriberCalls().at(-1)).toContain('status=disabled'))
  })

  it('shows a retryable error instead of a stuck loading message', async () => {
    const user = userEvent.setup()
    let fail = true
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/subscribers/settings') return settings() as never
      if (path === '/admin/monitors') return [] as never
      if (fail) throw new Error('down')
      return list(1) as never
    })
    renderPage()
    expect(await screen.findByText('Could not load subscribers.')).toBeInTheDocument()
    fail = false
    await user.click(screen.getByRole('button', { name: /Try again/ }))
    expect(await screen.findByText('reader@example.test')).toBeInTheDocument()
  })
})
