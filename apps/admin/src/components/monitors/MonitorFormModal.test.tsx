import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Monitor } from '@bsp/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import MonitorFormModal from './MonitorFormModal'

vi.mock('../../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() },
}))

const vaults = [{ id: 7, name: 'Production' }]
const secrets = [
  { id: 11, name: 'service-login', type: 'userpass' },
  { id: 12, name: 'service-json', type: 'json' },
]

function mockGets(overrides: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    '/admin/vaults': vaults,
    '/admin/vaults/7/secrets': secrets,
    '/admin/notifications/channels': [
      { id: 3, name: 'On-call email', type: 'email', enabled: true },
      { id: 4, name: 'Legacy hook', type: 'webhook', enabled: false },
    ],
    '/admin/monitors': [{ id: 1, name: 'Database' }, { id: 2, name: 'Edge' }],
    ...overrides,
  }
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path in routes) return routes[path]
    throw new Error(`Unexpected GET ${path}`)
  })
}

/** Field labels are not linked to their inputs, so resolve the control next to the label text. */
function field<T extends HTMLElement = HTMLInputElement>(label: string): T {
  const labelElement = screen.getAllByText(label, { selector: 'label' })[0]
  const control = labelElement?.parentElement?.querySelector('input, select, textarea')
  if (!control) throw new Error(`No control for label ${label}`)
  return control as T
}

function renderModal(monitor: Monitor | null = null) {
  const onClose = vi.fn()
  const onSaved = vi.fn()
  render(<MonitorFormModal monitor={monitor} onClose={onClose} onSaved={onSaved} />)
  return { onClose, onSaved }
}

function createdBody() {
  return vi.mocked(api.post).mock.calls.find(([path]) => path === '/admin/monitors')?.[1] as Record<string, unknown>
}

function existingMonitor(patch: Partial<Monitor> = {}): Monitor {
  return {
    id: 2,
    name: 'Edge',
    type: 'https',
    intervalSecs: 120,
    timeoutMs: 5000,
    retries: 2,
    failureThreshold: 3,
    recoveryThreshold: 2,
    config: { url: 'https://edge.example.test/health', method: 'HEAD', expectedStatus: 204, keyword: 'ok' },
    currentStatus: 'up',
    lastCheckedAt: null,
    webhookToken: null,
    tags: [{ label: 'prod', color: '#6366f1' }],
    certExpiresAt: null,
    certCheckedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

describe('MonitorFormModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGets()
    vi.mocked(api.post).mockResolvedValue({ id: 42 })
    vi.mocked(api.put).mockResolvedValue({})
    vi.mocked(api.patch).mockResolvedValue({})
  })

  it('starts a new monitor on the preselected type with its default config', async () => {
    const user = userEvent.setup()
    render(<MonitorFormModal monitor={null} initialType="dns" onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'DNS' })).toHaveAttribute('aria-pressed', 'true')

    await user.type(field('Name'), 'Resolver')
    await user.type(field('Hostname'), 'example.test')
    await user.click(screen.getByRole('button', { name: /Create Monitor/ }))
    await waitFor(() => expect(createdBody()).toMatchObject({ type: 'dns', config: { hostname: 'example.test', recordType: 'A' } }))
  })

  it('creates an HTTPS monitor and saves its channels and dependencies', async () => {
    const user = userEvent.setup()
    const { onSaved } = renderModal()

    await user.type(field('Name'), 'Public API')
    await user.clear(field('URL'))
    await user.type(field('URL'), 'https://api.example.test/health')
    await user.selectOptions(field<HTMLSelectElement>('Method'), 'POST')
    await user.clear(field('Expected Status'))
    await user.type(field('Expected Status'), '201')
    await user.type(field('Keyword (optional)'), 'healthy')

    await user.click(screen.getByTitle('Alerts'))
    await user.click(await screen.findByRole('checkbox', { name: /On-call email/ }))
    expect(screen.getByText('disabled')).toBeInTheDocument()
    await user.click(screen.getByTitle('Depends on'))
    await user.click(await screen.findByRole('checkbox', { name: /Database/ }))

    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(createdBody()).toEqual({
      name: 'Public API',
      type: 'https',
      intervalSecs: 60,
      timeoutMs: 10000,
      retries: 1,
      failureThreshold: 1,
      recoveryThreshold: 1,
      config: { url: 'https://api.example.test/health', method: 'POST', expectedStatus: 201, keyword: 'healthy' },
      tags: [],
    })
    expect(api.put).toHaveBeenCalledWith('/admin/notifications/monitor/42/channels', { channelIds: [3] })
    expect(api.put).toHaveBeenCalledWith('/admin/monitors/42/dependencies', { dependsOnIds: [1] })
  })

  it('saves TLS certificate expiry warnings, offered only for HTTPS URLs', async () => {
    const user = userEvent.setup()
    const { onSaved } = renderModal()

    await user.type(field('Name'), 'Shop')
    await user.clear(field('URL'))
    await user.type(field('URL'), 'http://shop.example.test')
    expect(screen.queryByRole('checkbox', { name: /TLS certificate expires/ })).not.toBeInTheDocument()

    await user.clear(field('URL'))
    await user.type(field('URL'), 'https://shop.example.test')
    await user.click(screen.getByRole('checkbox', { name: /TLS certificate expires/ }))
    expect(screen.getByText(/with reminders 7, 3, 1 days before expiry/)).toBeInTheDocument()
    await user.clear(field('Warn days before expiry'))
    await user.type(field('Warn days before expiry'), '30')

    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(createdBody()['config']).toEqual({
      url: 'https://shop.example.test', method: 'GET', expectedStatus: 200, certExpiry: { enabled: true, warnDays: 30 },
    })
  })

  it('blocks submission while a required field is empty', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))

    expect(field('Name')).toBeInvalid()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('shows the fields of each monitor type and resets the config when switching', async () => {
    const user = userEvent.setup()
    renderModal()

    expect(screen.getByTitle('Auth')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Ping / TCP' }))
    expect(screen.queryByText('URL', { selector: 'label' })).not.toBeInTheDocument()
    expect(field('Host')).toHaveValue('')
    expect(field('Port')).toHaveValue(80)
    // Auth and request panels only exist for HTTPS monitors.
    expect(screen.queryByTitle('Auth')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Request')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'DNS' }))
    expect(field<HTMLSelectElement>('Record Type')).toHaveValue('A')
    expect(field('Custom Resolver (optional)')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'SQL Server' }))
    expect(field('Port')).toHaveValue(1433)
    expect(field('Test Query')).toHaveValue('SELECT 1')

    await user.click(screen.getByRole('button', { name: 'Webhook' }))
    expect(screen.getByText('A unique webhook URL will be generated after saving.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Test$/ })).not.toBeInTheDocument()
  })

  it('submits ping and DNS configurations', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.type(field('Name'), 'Router')
    await user.click(screen.getByRole('button', { name: 'Ping / TCP' }))
    await user.type(field('Host'), '10.0.0.1')
    await user.selectOptions(field<HTMLSelectElement>('Mode'), 'icmp')
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))
    await waitFor(() => expect(createdBody()).toBeDefined())
    expect(createdBody()).toMatchObject({ type: 'ping', config: { host: '10.0.0.1', mode: 'icmp', port: 80 } })

    vi.mocked(api.post).mockClear()
    await user.click(screen.getByRole('button', { name: 'DNS' }))
    await user.type(field('Hostname'), 'example.test')
    await user.selectOptions(field<HTMLSelectElement>('Record Type'), 'MX')
    await user.type(field('Expected Value'), 'mail.example.test')
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))
    await waitFor(() => expect(createdBody()).toBeDefined())
    expect(createdBody()).toMatchObject({
      type: 'dns',
      config: { hostname: 'example.test', recordType: 'MX', expectedValue: 'mail.example.test' },
    })
  })

  it('submits SQL Server credentials from direct input or from a vault secret', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.type(field('Name'), 'Orders DB')
    await user.click(screen.getByRole('button', { name: 'SQL Server' }))
    await user.type(field('Host'), 'sql.internal')
    await user.type(field('Database'), 'orders')
    expect(screen.getByText(/store credentials in Vault/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'From Vault' }))
    await user.selectOptions(field<HTMLSelectElement>('Secret'), '12')
    expect(screen.getByText('JSON Field Mapping')).toBeInTheDocument()
    await user.type(screen.getAllByPlaceholderText('JSON key (e.g. "username")')[0]!, 'login')
    await user.type(screen.getAllByPlaceholderText('JSON key (e.g. "password")')[0]!, 'pwd')
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))

    await waitFor(() => expect(createdBody()).toBeDefined())
    expect(createdBody()).toMatchObject({
      type: 'sqlserver',
      config: {
        host: 'sql.internal',
        port: 1433,
        database: 'orders',
        query: 'SELECT 1',
        vault: { vaultId: 7, secretId: 12, fieldMapping: { username: 'login', password: 'pwd' } },
      },
    })
  })

  it('requires a vault for SQL Server connection strings', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.click(screen.getByRole('button', { name: 'SQL Server' }))
    await user.click(screen.getByRole('button', { name: 'Connection string' }))

    expect(screen.getByText('Connection strings contain credentials and must always be stored in Vault.')).toBeInTheDocument()
    expect(screen.queryByText('Host', { selector: 'label' })).not.toBeInTheDocument()
    await user.selectOptions(field<HTMLSelectElement>('Vault'), '7')
    await user.selectOptions(field<HTMLSelectElement>('Secret'), '11')
    expect(screen.getByText(/cannot be used as a connection string/)).toBeInTheDocument()
  })

  it.each([
    {
      label: 'Basic',
      fill: async (user: ReturnType<typeof userEvent.setup>) => {
        await user.type(field('Username'), 'svc')
        await user.type(field('Password'), 's3cret')
      },
      auth: { type: 'basic', basic: { username: 'svc', password: 's3cret' } },
    },
    {
      label: 'OAuth2',
      fill: async (user: ReturnType<typeof userEvent.setup>) => {
        await user.type(field('Token URL'), 'https://auth.example.test/token')
        await user.type(field('Scope (optional)'), 'read')
        await user.type(field('Client ID'), 'client')
        await user.type(field('Client Secret'), 'secret')
      },
      auth: { type: 'oauth2', oauth2: { tokenUrl: 'https://auth.example.test/token', scope: 'read', clientId: 'client', clientSecret: 'secret' } },
    },
    {
      label: 'CAS',
      fill: async (user: ReturnType<typeof userEvent.setup>) => {
        await user.type(field('CAS Server URL'), 'https://cas.example.test/cas')
        await user.type(field('Username'), 'jdoe')
        await user.type(field('Password'), 'pw')
      },
      auth: { type: 'cas', cas: { casServerUrl: 'https://cas.example.test/cas', username: 'jdoe', password: 'pw' } },
    },
  ])('includes $label authentication in the HTTPS config', async ({ label, fill, auth }) => {
    const user = userEvent.setup()
    renderModal()

    await user.type(field('Name'), 'Secured')
    await user.click(screen.getByTitle('Auth'))
    expect(screen.getByText('No authentication configured.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: label }))
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))

    await waitFor(() => expect(createdBody()).toBeDefined())
    expect((createdBody()['config'] as Record<string, unknown>)['auth']).toEqual(auth)
  })

  it('edits custom request headers and body', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.type(field('Name'), 'Webhook target')
    await user.click(screen.getByTitle('Request'))
    expect(screen.getByText('No custom headers.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '+ Add' }))
    await user.type(screen.getByPlaceholderText('Header name'), 'X-Env')
    await user.type(screen.getByPlaceholderText('Value'), 'prod')
    await user.click(screen.getByRole('button', { name: '+ Add' }))
    await user.click(screen.getByRole('button', { name: 'Remove header 2' }))
    await user.click(screen.getByPlaceholderText(/"key": "value"/))
    await user.paste('{"ping":true}')
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))

    await waitFor(() => expect(createdBody()).toBeDefined())
    expect(createdBody()['config']).toMatchObject({ headers: { 'X-Env': 'prod' }, body: '{"ping":true}' })
  })

  it('adds a new tag and reuses an existing one', async () => {
    const user = userEvent.setup()
    render(
      <MonitorFormModal monitor={null} allTags={[{ label: 'critical', color: '#ef4444' }]} onClose={vi.fn()} onSaved={vi.fn()} />,
    )

    await user.type(field('Name'), 'Tagged')
    await user.click(screen.getByTitle('Tags'))
    await user.type(screen.getByPlaceholderText('Tag label…'), 'eu-west{Enter}')
    await user.type(screen.getByPlaceholderText('Tag label…'), 'crit')
    await user.click(await screen.findByRole('button', { name: 'critical' }))
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))

    await waitFor(() => expect(createdBody()).toBeDefined())
    expect(createdBody()['tags']).toEqual([
      { label: 'eu-west', color: '#6366f1' },
      { label: 'critical', color: '#ef4444' },
    ])
  })

  it('pre-fills an existing monitor and saves it with PATCH', async () => {
    const user = userEvent.setup()
    mockGets({
      '/admin/notifications/monitor/2/channels': [3],
      '/admin/monitors/2/dependencies': { dependsOnIds: [1] },
    })
    const { onSaved } = renderModal(existingMonitor())

    expect(screen.getByRole('heading', { name: 'Edit Monitor' })).toBeInTheDocument()
    expect(field('Name')).toHaveValue('Edge')
    expect(field('Interval (s)')).toHaveValue(120)
    expect(field('Timeout (ms)')).toHaveValue(5000)
    expect(field('Attempts')).toHaveValue(2)
    expect(field('Alert after (checks)')).toHaveValue(3)
    expect(field('Recover after (checks)')).toHaveValue(2)
    expect(field('URL')).toHaveValue('https://edge.example.test/health')
    expect(field<HTMLSelectElement>('Method')).toHaveValue('HEAD')
    expect(field('Keyword (optional)')).toHaveValue('ok')
    await user.click(screen.getByTitle('Depends on'))
    // A monitor can never depend on itself.
    expect(screen.queryByRole('checkbox', { name: /Edge/ })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Database/ })).toBeChecked())

    await user.clear(field('Name'))
    await user.type(field('Name'), 'Edge proxy')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(api.patch).toHaveBeenCalledWith('/admin/monitors/2', expect.objectContaining({
      name: 'Edge proxy',
      config: existingMonitor().config,
      tags: [{ label: 'prod', color: '#6366f1' }],
    }))
    expect(api.put).toHaveBeenCalledWith('/admin/notifications/monitor/2/channels', { channelIds: [3] })
    expect(api.put).toHaveBeenCalledWith('/admin/monitors/2/dependencies', { dependsOnIds: [1] })
  })

  it('preloads vault secrets referenced by an existing monitor', async () => {
    mockGets({
      '/admin/notifications/monitor/2/channels': [],
      '/admin/monitors/2/dependencies': { dependsOnIds: [] },
    })
    const user = userEvent.setup()
    renderModal(existingMonitor({
      config: {
        url: 'https://edge.example.test',
        method: 'GET',
        expectedStatus: 200,
        auth: { type: 'basic', basic: { vault: { vaultId: 7, secretId: 11, fieldMapping: {} } } },
      },
    }))

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/vaults/7/secrets'))
    await user.click(screen.getByTitle('Auth'))
    expect(await screen.findByText(/Auto-mapped:/)).toBeInTheDocument()
    expect(field<HTMLSelectElement>('Secret')).toHaveValue('11')
  })

  it('shows the save error without closing', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Name already exists'))
    const { onSaved } = renderModal()

    await user.type(field('Name'), 'Duplicate')
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))

    expect(await screen.findByText('Name already exists')).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('keeps a new webhook monitor open so its URL can be copied', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    vi.mocked(api.post).mockResolvedValueOnce({ id: 9, webhookToken: 'tok123' })
    const { onSaved } = renderModal()

    await user.type(field('Name'), 'Cron job')
    await user.click(screen.getByRole('button', { name: 'Webhook' }))
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))

    const url = `${window.location.origin}/api/v1/hook/tok123`
    expect(await screen.findByDisplayValue(url)).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /Copy/ }))
    expect(writeText).toHaveBeenCalledWith(url)
    expect(await screen.findByText('Copied!')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(onSaved).toHaveBeenCalledOnce()
    expect(api.post).toHaveBeenCalledTimes(1)
  })

  it('resets the token of an existing webhook monitor', async () => {
    const user = userEvent.setup()
    mockGets({
      '/admin/notifications/monitor/5/channels': [],
      '/admin/monitors/5/dependencies': { dependsOnIds: [] },
    })
    vi.mocked(api.post).mockResolvedValueOnce({ webhookToken: 'fresh' })
    renderModal(existingMonitor({ id: 5, type: 'webhook', config: {}, webhookToken: 'stale' }))

    expect(screen.getByDisplayValue(/\/hook\/stale$/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Reset token/ }))
    // Rotating the token breaks the old URL, so it needs confirmation first.
    const dialog = screen.getByRole('dialog', { name: 'Reset webhook token' })
    expect(within(dialog).getByText(/The existing webhook URL will stop working/)).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Reset token' }))

    expect(api.post).toHaveBeenCalledWith('/admin/monitors/5/reset-token', {})
    expect(await screen.findByDisplayValue(/\/hook\/fresh$/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Reset webhook token' })).not.toBeInTheDocument())
  })

  it('shows why a webhook token could not be reset', async () => {
    const user = userEvent.setup()
    mockGets({
      '/admin/notifications/monitor/5/channels': [],
      '/admin/monitors/5/dependencies': { dependsOnIds: [] },
    })
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Monitor is locked'))
    renderModal(existingMonitor({ id: 5, type: 'webhook', config: {}, webhookToken: 'stale' }))

    await user.click(screen.getByRole('button', { name: /Reset token/ }))
    await user.click(within(screen.getByRole('dialog', { name: 'Reset webhook token' })).getByRole('button', { name: 'Reset token' }))

    expect(await screen.findByText("Couldn't reset the token: Monitor is locked")).toBeInTheDocument()
    expect(screen.getByDisplayValue(/\/hook\/stale$/)).toBeInTheDocument()
  })

  it('runs a test against the current configuration and renders the steps', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({
      overall: 'error',
      totalMs: 321,
      steps: [
        { label: 'Authorization: none', status: 'info' },
        { label: 'DNS resolved', status: 'ok', durationMs: 4 },
        { label: 'Expected status 200, got 503', status: 'error', detail: 'Service Unavailable' },
      ],
    })
    renderModal()

    await user.clear(field('URL'))
    await user.type(field('URL'), 'https://down.example.test')
    await user.click(screen.getByRole('button', { name: /Test$/ }))

    expect(api.post).toHaveBeenCalledWith('/admin/monitors/test', {
      type: 'https',
      config: { url: 'https://down.example.test', method: 'GET', expectedStatus: 200 },
      timeoutMs: 10000,
    })
    expect(await screen.findByText('Test failed')).toBeInTheDocument()
    expect(screen.getByText('321ms total')).toBeInTheDocument()
    expect(screen.getByText('DNS resolved')).toBeInTheDocument()
    expect(screen.getByText('4ms')).toBeInTheDocument()
    expect(screen.getByText('Service Unavailable')).toBeInTheDocument()
    // Informational steps are only part of the downloadable report.
    expect(screen.queryByText('Authorization: none')).not.toBeInTheDocument()
  })

  it('downloads the full test report', async () => {
    const user = userEvent.setup()
    const createObjectURL = vi.fn(() => 'blob:report')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.mocked(api.post).mockResolvedValueOnce({
      overall: 'ok',
      totalMs: 12,
      steps: [{ label: 'Connected', status: 'ok', durationMs: 12, cookies: { SESSION: 'abc' } }],
    })
    renderModal()

    await user.click(screen.getByRole('button', { name: /Test$/ }))
    expect(await screen.findByText('All checks passed')).toBeInTheDocument()
    await user.click(screen.getByTitle('Download full test report'))

    expect(click).toHaveBeenCalledOnce()
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0]
    const text = await blob.text()
    expect(text).toContain('Result: PASSED  |  Total: 12ms')
    expect(text).toContain('[✓] Connected  (12ms)')
    expect(text).toContain('SESSION = abc')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:report')
  })

  it('reports a failed test request as a failed step', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Forbidden'))
    renderModal()

    await user.click(screen.getByRole('button', { name: /Test$/ }))

    expect(await screen.findByText('Test request failed')).toBeInTheDocument()
    expect(screen.getByText('Forbidden')).toBeInTheDocument()
  })

  it('closes on cancel', async () => {
    const user = userEvent.setup()
    const { onClose } = renderModal()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
