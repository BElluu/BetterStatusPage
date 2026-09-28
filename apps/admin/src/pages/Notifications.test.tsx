import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { NotificationChannel, NotificationDelivery } from '@bsp/shared'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import NotificationHistoryPage from './NotificationHistory'
import NotificationsPage from './Notifications'

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))

// The channel form has its own tests; here it only needs to prove the page opens it with the right channel.
vi.mock('../components/notifications/ChannelFormModal', () => ({
  default: ({ channel, onClose, onSaved }: { channel: NotificationChannel | null; onClose: () => void; onSaved: () => void }) => (
    <div role="dialog" aria-label="Channel form">
      <p>{channel ? `Editing ${channel.name}` : 'New channel'}</p>
      <button onClick={onSaved}>Save channel</button>
      <button onClick={onClose}>Close form</button>
    </div>
  ),
}))

const channels = [
  { id: 1, name: 'Ops mail', type: 'email', config: { to: 'ops@example.test' }, enabled: 1, notifyOnRecovery: 1 },
  { id: 2, name: 'Discord ops', type: 'discord', config: { webhookUrl: 'https://discord.test/hook' }, enabled: 0, notifyOnRecovery: 0 },
  { id: 3, name: 'Generic hook', type: 'webhook', config: { url: 'https://hooks.test/in' }, enabled: 1, notifyOnRecovery: 0 },
  { id: 4, name: 'Teams room', type: 'teams', config: { webhookUrl: 'https://teams.test/hook' }, enabled: 1, notifyOnRecovery: 0 },
  { id: 5, name: 'Slack room', type: 'slack', config: { webhookUrl: 'https://slack.test/hook' }, enabled: 1, notifyOnRecovery: 0 },
] as unknown as NotificationChannel[]

const smtpDirect = {
  host: 'smtp.example.test', port: 587, secure: 0, user: 'mailer', password: 'stored-pass',
  fromAddress: 'alerts@example.test', fromName: 'BSP Alerts', vault: null, updatedAt: 1,
}

function delivery(overrides: Partial<NotificationDelivery>): NotificationDelivery {
  return {
    id: 1, channelId: 1, channelName: 'Ops mail', channelType: 'email', monitorId: 1, monitorName: 'Checkout API',
    eventType: 'alert', status: 'delivered', targetStatus: 'down', previousStatus: 'up', attemptCount: 1, maxAttempts: 3,
    nextAttemptAt: null, lastAttemptAt: 1, deliveredAt: 1, lastError: null, suppressionReason: null, groupKey: null,
    createdAt: Date.UTC(2026, 8, 1, 12), updatedAt: 1,
    ...overrides,
  } as NotificationDelivery
}

const deliveries = [
  delivery({ id: 1 }),
  delivery({ id: 2, status: 'failed', eventType: 'recovery', targetStatus: 'up', previousStatus: 'down', attemptCount: 3, lastError: 'SMTP 550 mailbox unavailable' }),
  delivery({ id: 3, status: 'suppressed', eventType: 'test', suppressionReason: 'quiet-hours', attemptCount: 0, targetStatus: 'degraded', previousStatus: 'pending' }),
  delivery({ id: 4, status: 'pending', attemptCount: 0, nextAttemptAt: Date.now() + 3_600_000, targetStatus: 'affected' }),
]

let smtp: unknown = smtpDirect
let deliveryPages = 1

function mockGets() {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/notifications/channels') return channels
    if (path === '/admin/notifications/smtp') return smtp
    if (path === '/admin/vaults') return [{ id: 7, name: 'Mail vault' }]
    if (path === '/admin/vaults/7/secrets') return [{ id: 70, name: 'smtp-login', type: 'userpass' }, { id: 71, name: 'smtp-json', type: 'json' }]
    if (path.startsWith('/admin/notifications/deliveries?')) return { deliveries, total: 4 * deliveryPages, page: 1, pages: deliveryPages }
    if (path === '/admin/notifications/deliveries/2') {
      return { ...deliveries[1], attempts: [
        { id: 1, deliveryId: 2, attemptNumber: 1, status: 'failed', error: 'timeout', startedAt: 1, completedAt: Date.UTC(2026, 8, 1, 12) },
        { id: 2, deliveryId: 2, attemptNumber: 2, status: 'delivered', error: null, startedAt: 1, completedAt: Date.UTC(2026, 8, 1, 12) },
      ] }
    }
    if (path === '/admin/notifications/deliveries/3') return { ...deliveries[2], attempts: [] }
    throw new Error(`Unexpected GET ${path}`)
  })
}

function renderWithProviders(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>)
}

async function openSmtp(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /SMTP Settings/ }))
  // Wait for the stored settings to populate the form.
  await waitFor(() => expect(screen.getByPlaceholderText('smtp.example.com')).toHaveValue(smtpDirect.host))
}

describe('NotificationsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    smtp = smtpDirect
    deliveryPages = 1
    mockGets()
    vi.mocked(api.post).mockResolvedValue({})
    vi.mocked(api.put).mockResolvedValue({})
    vi.mocked(api.delete).mockResolvedValue(undefined)
  })

  it('lists channels with their recipients, recovery flag and status', async () => {
    renderWithProviders(<NotificationsPage />)

    expect(await screen.findByText('Ops mail')).toBeInTheDocument()
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(5)
    expect(within(rows[0]!).getByText('ops@example.test')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('Yes')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('Active')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('https://discord.test/hook')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('Disabled')).toBeInTheDocument()
    expect(within(rows[2]!).getByText('https://hooks.test/in')).toBeInTheDocument()
    expect(within(rows[3]!).getByText('teams')).toBeInTheDocument()
    expect(within(rows[4]!).getByText('slack')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Delivery history/ })).toHaveAttribute('href', '/admin/notifications/history')
  })

  it('shows an empty state without channels', async () => {
    vi.mocked(api.get).mockResolvedValueOnce([])
    renderWithProviders(<NotificationsPage />)

    expect(await screen.findByText('No notification channels yet')).toBeInTheDocument()
  })

  it('opens the channel form for create and edit', async () => {
    const user = userEvent.setup()
    renderWithProviders(<NotificationsPage />)

    await user.click(screen.getByRole('button', { name: 'Add Channel' }))
    expect(screen.getByText('New channel')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close form' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click((await screen.findAllByTitle('Edit'))[1]!)
    expect(screen.getByText('Editing Discord ops')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save channel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('deletes a channel only after confirmation', async () => {
    const user = userEvent.setup()
    renderWithProviders(<NotificationsPage />)

    await user.click((await screen.findAllByTitle('Delete'))[0]!)
    expect(screen.getByText('Delete "Ops mail"? This will also remove it from all monitors.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.delete).not.toHaveBeenCalled()

    await user.click(screen.getAllByTitle('Delete')[0]!)
    await user.click(within(screen.getByRole('dialog', { name: 'Delete channel' })).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/notifications/channels/1'))
  })

  it('saves edited SMTP settings with direct credentials and a masked password field', async () => {
    const user = userEvent.setup()
    renderWithProviders(<NotificationsPage />)

    await openSmtp(user)
    const password = screen.getByPlaceholderText('••••••••')
    expect(password).toHaveAttribute('type', 'password')
    const host = screen.getByPlaceholderText('smtp.example.com')
    await user.clear(host)
    await user.type(host, 'mail.example.test')
    await user.click(screen.getByRole('switch', { name: 'Use TLS/SSL (port 465)' }))
    await user.click(screen.getByRole('button', { name: 'Save Settings' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/notifications/smtp', {
      host: 'mail.example.test', port: 587, secure: 1, fromAddress: 'alerts@example.test', fromName: 'BSP Alerts',
      user: 'mailer', password: 'stored-pass', vault: null,
    }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'SMTP Settings' })).not.toBeInTheDocument())
  })

  it('shows the server error and keeps the SMTP dialog open when saving fails', async () => {
    const user = userEvent.setup()
    vi.mocked(api.put).mockRejectedValueOnce(new Error('Invalid SMTP host'))
    renderWithProviders(<NotificationsPage />)

    await openSmtp(user)
    await user.click(screen.getByRole('button', { name: 'Save Settings' }))

    expect(await screen.findByText('Invalid SMTP host')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'SMTP Settings' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save Settings' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('heading', { name: 'SMTP Settings' })).not.toBeInTheDocument()
  })

  it('switches SMTP credentials to a vault secret and never sends the direct password', async () => {
    const user = userEvent.setup()
    renderWithProviders(<NotificationsPage />)

    await openSmtp(user)
    await user.click(screen.getByRole('button', { name: 'From Vault' }))
    expect(screen.queryByPlaceholderText('••••••••')).not.toBeInTheDocument()
    const [vaultSelect, secretSelect] = screen.getAllByRole('combobox') as [HTMLSelectElement, HTMLSelectElement]
    await waitFor(() => expect(vaultSelect).toHaveValue('7'))
    await screen.findByRole('option', { name: 'smtp-login (userpass)' })
    await user.selectOptions(secretSelect, '70')
    expect(screen.getByText(/Auto-mapped:/)).toBeInTheDocument()

    await user.selectOptions(secretSelect, '71')
    await user.type(screen.getByPlaceholderText('JSON key (e.g. "username")'), 'u')
    await user.type(screen.getByPlaceholderText('JSON key (e.g. "password")'), 'p')
    await user.click(screen.getByRole('button', { name: 'Save Settings' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/notifications/smtp', expect.objectContaining({
      user: '', password: '', vault: { vaultId: 7, secretId: 71, fieldMapping: { username: 'u', password: 'p' } },
    })))
  })

  it('loads stored vault-backed SMTP credentials into the vault form', async () => {
    const user = userEvent.setup()
    smtp = { ...smtpDirect, user: '', password: '', vault: { vaultId: 7, secretId: 70 } }
    renderWithProviders(<NotificationsPage />)

    await openSmtp(user)
    expect(await screen.findByText(/Auto-mapped:/)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('••••••••')).not.toBeInTheDocument()
  })

  it('sends a test email and reports success or the server error', async () => {
    const user = userEvent.setup()
    renderWithProviders(<NotificationsPage />)

    await openSmtp(user)
    const send = screen.getByRole('button', { name: /Send$/ })
    expect(send).toBeDisabled()
    await user.type(screen.getByPlaceholderText('recipient@example.com'), 'me@example.test')
    await user.click(send)
    expect(await screen.findByText('Test email sent to me@example.test')).toBeInTheDocument()
    expect(api.post).toHaveBeenCalledWith('/admin/notifications/smtp/test', { to: 'me@example.test' })

    vi.mocked(api.post).mockRejectedValueOnce(new Error('Connection refused'))
    await user.click(send)
    expect(await screen.findByText('Connection refused')).toBeInTheDocument()
  })
})

describe('NotificationHistoryPage delivery log', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deliveryPages = 1
    mockGets()
    vi.mocked(api.post).mockResolvedValue({})
  })

  it('renders deliveries with their status, event and suppression details', async () => {
    renderWithProviders(<NotificationHistoryPage />)

    expect(await screen.findAllByText('Checkout API')).toHaveLength(4)
    expect(screen.getByRole('heading', { name: 'Notification delivery history' })).toBeInTheDocument()
    const rows = screen.getAllByRole('row').slice(1)
    expect(within(rows[0]!).getByText('Delivered')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('Operational → Down')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('Failed')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('Recovery')).toBeInTheDocument()
    expect(within(rows[2]!).getByText('Quiet hours')).toBeInTheDocument()
    expect(within(rows[2]!).getByText('Pending → Degraded')).toBeInTheDocument()
    expect(within(rows[3]!).getByText(/^Held until/)).toBeInTheDocument()
    expect(within(rows[3]!).getByText('Operational → Affected')).toBeInTheDocument()
  })

  it('expands a failed delivery to show attempts and retries it', async () => {
    const user = userEvent.setup()
    renderWithProviders(<NotificationHistoryPage />)

    // Row 0 is the header; row 2 is the failed delivery.
    const rows = await screen.findAllByRole('row')
    expect(screen.queryByText('SMTP 550 mailbox unavailable')).not.toBeInTheDocument()
    await user.click(rows[2]!)

    expect(await screen.findByText('SMTP 550 mailbox unavailable')).toBeInTheDocument()
    expect(await screen.findByText('timeout')).toBeInTheDocument()
    expect(screen.getByText('#2')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry now' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/notifications/deliveries/2/retry', {}))
  })

  it('expands a delivery from its details button with aria-expanded', async () => {
    const user = userEvent.setup()
    renderWithProviders(<NotificationHistoryPage />)

    const toggles = await screen.findAllByRole('button', { name: /^Show details for/ })
    expect(toggles[1]).toHaveAttribute('aria-expanded', 'false')
    toggles[1]!.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('SMTP 550 mailbox unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Hide details for/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('explains a suppressed delivery that was never attempted', async () => {
    const user = userEvent.setup()
    renderWithProviders(<NotificationHistoryPage />)

    const rows = await screen.findAllByRole('row')
    await user.click(rows[3]!)

    expect(await screen.findByText('Never attempted.')).toBeInTheDocument()
    expect(screen.getByText(/inside its quiet window/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry now' })).not.toBeInTheDocument()
  })

  it('sends filters to the server and pages through results', async () => {
    const user = userEvent.setup()
    deliveryPages = 2
    renderWithProviders(<NotificationHistoryPage />)

    await screen.findByText('Page 1 of 2 · 8 deliveries')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'failed')
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Channel' }), '2')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Event' }), 'alert')
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(
      '/admin/notifications/deliveries?page=1&limit=20&status=failed&channelId=2&eventType=alert',
    ))

    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    expect(await screen.findByText('Page 2 of 2 · 8 deliveries')).toBeInTheDocument()
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('page=2')))
  })

  it('shows an empty state when no deliveries match', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/notifications/channels') return []
      return { deliveries: [], total: 0, page: 1, pages: 1 }
    })
    renderWithProviders(<NotificationHistoryPage />)

    expect(await screen.findByText('No deliveries match these filters.')).toBeInTheDocument()
  })
})
