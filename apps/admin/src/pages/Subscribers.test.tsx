import { render, screen, within } from '@testing-library/react'
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
    await user.click(within(rss).getByText('Enable RSS / Atom'))
    expect(within(rss).getByText('Offered to visitors')).toBeInTheDocument()
    expect(screen.getByText('Visitors will choose from: Slack, RSS / Atom.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled()
  })
})
