import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Monitor } from '@bsp/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import MonitorFormModal from './MonitorFormModal'

vi.mock('../YamlViewModal', () => ({
  YamlViewModal: ({ kind, objectKey, onClose }: { kind: string; objectKey?: string; onClose: () => void }) => (
    <div role="dialog" aria-label="YAML view">{kind} {objectKey ?? ''}<button type="button" onClick={onClose}>Close YAML</button></div>
  ),
}))

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
    '/admin/incident-templates': [],
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

/** Opens the type picker and chooses an entry. */
async function pickType(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('button', { name: /^Type / }))
  await user.click(screen.getByRole('option', { name: (name) => name.startsWith(label) }))
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
    key: 'edge',
    name: 'Edge',
    type: 'https',
    intervalSecs: 120,
    timeoutMs: 5000,
    retries: 2,
    failureThreshold: 3,
    recoveryThreshold: 2,
    autoIncidentMinutes: null,
    autoIncidentMode: 'draft',
    autoIncidentTemplateId: null,
    latencyAlertFactor: null,
    latencyAlertWindowMinutes: 30,
    latencyAlertMinDeltaMs: 200,
    latencyAlertSustain: 3,
    latencyBaselineP95: null,
    latencyAlertSince: null,
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
    expect(screen.getByRole('button', { name: /^Type DNS/ })).toBeInTheDocument()

    await user.type(field('Name'), 'Resolver')
    await user.type(field('Hostname'), 'example.test')
    await user.click(screen.getByRole('button', { name: /Create Monitor/ }))
    await waitFor(() => expect(createdBody()).toMatchObject({ type: 'dns', config: { hostname: 'example.test', recordType: 'A' } }))
  })

  it('offers Bypass caches for GET and HEAD, not for POST, and saves it', async () => {
    const user = userEvent.setup()
    renderModal()
    await user.type(field('Name'), 'Cached site')
    await user.clear(field('URL'))
    await user.type(field('URL'), 'https://example.test')
    await user.click(screen.getByLabelText('Bypass caches'))
    expect(screen.getByText(/bsp_cachebuster/)).toBeInTheDocument()
    await user.selectOptions(field<HTMLSelectElement>('Method'), 'POST')
    expect(screen.queryByLabelText('Bypass caches')).not.toBeInTheDocument()
    await user.selectOptions(field<HTMLSelectElement>('Method'), 'HEAD')
    expect(screen.getByLabelText('Bypass caches')).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))
    await waitFor(() => expect(createdBody()).toBeDefined())
    expect(createdBody()).toMatchObject({ type: 'https', config: { method: 'HEAD', cacheBuster: true } })
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
    await user.click(screen.getByTitle('Checks'))
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
      autoIncidentMinutes: null,
      autoIncidentMode: 'draft',
      autoIncidentTemplateId: null,
      latencyAlertFactor: null,
      latencyAlertWindowMinutes: 30,
      latencyAlertMinDeltaMs: 200,
      latencyAlertSustain: 3,
      config: { url: 'https://api.example.test/health', method: 'POST', expectedStatus: 201, keyword: 'healthy' },
      tags: [],
    })
    expect(api.put).toHaveBeenCalledWith('/admin/notifications/monitor/42/channels', { channelIds: [3] })
    expect(api.put).toHaveBeenCalledWith('/admin/monitors/42/dependencies', { dependsOnIds: [1] })
  })

  it('saves response checks on headers and JSON fields and a slow-response limit', async () => {
    const user = userEvent.setup()
    const { onSaved } = renderModal()

    await user.type(field('Name'), 'Cluster API')
    await user.clear(field('URL'))
    await user.type(field('URL'), 'https://api.example.test/status')
    expect(screen.queryByLabelText('Check 1 header name')).not.toBeInTheDocument()
    await user.click(screen.getByTitle('Checks'))
    await user.type(field('Degraded when slower than (ms, optional)'), '2000')

    await user.click(screen.getByRole('button', { name: '+ Add check' }))
    expect(screen.queryByText(/JSON paths look like/)).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Check 1 header name'), 'X-Replicas')
    await user.selectOptions(screen.getByLabelText('Check 1 condition'), 'equals')
    await user.type(screen.getByLabelText('Check 1 value'), '2')
    await user.selectOptions(screen.getByLabelText('Check 1 when it fails'), 'down')

    await user.click(screen.getByRole('button', { name: '+ Add check' }))
    await user.selectOptions(screen.getByLabelText('Check 2 target'), 'json')
    expect(screen.getByText(/JSON paths look like/)).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Check 2 JSON path'))
    await user.type(screen.getByLabelText('Check 2 JSON path'), '$.queue.length')
    await user.selectOptions(screen.getByLabelText('Check 2 condition'), 'lt')
    await user.type(screen.getByLabelText('Check 2 value'), '100')

    await user.click(screen.getByRole('button', { name: '+ Add check' }))
    await user.click(screen.getByRole('button', { name: 'Remove check 3' }))

    // "exists" takes no value, and the value typed before is not kept
    await user.selectOptions(screen.getByLabelText('Check 1 condition'), 'exists')
    expect(screen.queryByLabelText('Check 1 value')).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Check 1 condition'), 'equals')
    await user.type(screen.getByLabelText('Check 1 value'), '2')

    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(createdBody()['config']).toEqual({
      url: 'https://api.example.test/status',
      method: 'GET',
      expectedStatus: 200,
      degradedAboveMs: 2000,
      assertions: [
        { type: 'header', name: 'X-Replicas', op: 'equals', value: '2', onFail: 'down' },
        { type: 'json', path: '$.queue.length', op: 'lt', value: '100', onFail: 'degraded' },
      ],
    })
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

  it('saves Ignore TLS certificate errors, which replaces the certificate expiry warnings and needs an HTTPS URL', async () => {
    const user = userEvent.setup()
    const { onSaved } = renderModal()

    await user.type(field('Name'), 'Controller')
    await user.clear(field('URL'))
    await user.type(field('URL'), 'http://unifi.lan')
    expect(screen.queryByRole('checkbox', { name: 'Ignore TLS certificate errors' })).not.toBeInTheDocument()

    await user.clear(field('URL'))
    await user.type(field('URL'), 'https://unifi.lan')
    expect(screen.getByRole('checkbox', { name: /TLS certificate expires/ })).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Ignore TLS certificate errors' }))
    expect(screen.getByText(/The server certificate is not verified/)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /TLS certificate expires/ })).not.toBeInTheDocument()

    // Leaving HTTPS drops the setting, so it cannot stay on unseen.
    await user.clear(field('URL'))
    await user.type(field('URL'), 'http://unifi.lan')
    await user.clear(field('URL'))
    await user.type(field('URL'), 'https://unifi.lan')
    expect(screen.getByRole('checkbox', { name: 'Ignore TLS certificate errors' })).not.toBeChecked()

    await user.click(screen.getByRole('checkbox', { name: 'Ignore TLS certificate errors' }))
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(createdBody()['config']).toEqual({ url: 'https://unifi.lan', method: 'GET', expectedStatus: 200, ignoreTls: true })
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
    await pickType(user, 'Ping / TCP')
    expect(screen.queryByText('URL', { selector: 'label' })).not.toBeInTheDocument()
    expect(field('Host')).toHaveValue('')
    expect(field('Port')).toHaveValue(80)
    // Auth and request panels only exist for HTTPS monitors.
    expect(screen.queryByTitle('Auth')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Request')).not.toBeInTheDocument()

    await pickType(user, 'DNS')
    expect(field<HTMLSelectElement>('Record Type')).toHaveValue('A')
    expect(field('Custom Resolver (optional)')).toBeInTheDocument()

    await pickType(user, 'Database')
    expect(field('Port')).toHaveValue(1433)
    expect(field('Test Query')).toHaveValue('SELECT 1')

    await pickType(user, 'Webhook')
    expect(screen.getByText('A unique webhook URL will be generated after saving.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Test$/ })).not.toBeInTheDocument()
  })

  it('shows the Docker fields with a socket default', async () => {
    const user = userEvent.setup()
    renderModal()

    await pickType(user, 'Docker')
    expect(field('Docker endpoint')).toHaveValue('unix:///var/run/docker.sock')
    await user.type(field('Container name or ID'), 'my-app')
    expect(field('Container name or ID')).toHaveValue('my-app')
    expect(screen.getByRole('button', { name: /Test$/ })).toBeInTheDocument()
  })

  it('submits ping and DNS configurations', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.type(field('Name'), 'Router')
    await pickType(user, 'Ping / TCP')
    await user.type(field('Host'), '10.0.0.1')
    await user.selectOptions(field<HTMLSelectElement>('Mode'), 'icmp')
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))
    await waitFor(() => expect(createdBody()).toBeDefined())
    expect(createdBody()).toMatchObject({ type: 'ping', config: { host: '10.0.0.1', mode: 'icmp', port: 80 } })

    vi.mocked(api.post).mockClear()
    await pickType(user, 'DNS')
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
    await pickType(user, 'Database')
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

  it.each([
    { button: 'PostgreSQL', type: 'postgresql', port: 5432 },
    { button: 'MySQL / MariaDB', type: 'mysql', port: 3306 },
    { button: 'MongoDB', type: 'mongodb', port: 27017 },
  ])('submits $button with its default port and test query', async ({ button, type, port }) => {
    const user = userEvent.setup()
    renderModal()

    await user.type(field('Name'), 'Orders DB')
    await pickType(user, 'Database')
    await user.click(screen.getByRole('button', { name: button }))
    await user.type(field('Host'), 'db.internal')
    await user.type(field('Database'), 'orders')
    await user.type(field('User'), 'monitor')
    await user.type(field('Password'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))

    await waitFor(() => expect(createdBody()).toBeDefined())
    expect(createdBody()).toMatchObject({
      type,
      config: { host: 'db.internal', port, database: 'orders', user: 'monitor', query: type === 'mongodb' ? '{"ping":1}' : 'SELECT 1' },
    })
  })

  it('submits Oracle with a service name, its own default query and no encrypt-without-checking option', async () => {
    const user = userEvent.setup()
    renderModal()
    await user.type(field('Name'), 'Ledger')
    await pickType(user, 'Database')
    await user.click(screen.getByRole('button', { name: 'Oracle' }))
    expect(field('Port')).toHaveValue(1521)
    expect(field('Test Query')).toHaveValue('SELECT 1 FROM DUAL')
    expect(screen.queryByText('Database', { selector: 'label' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Encrypted, certificate not checked' })).not.toBeInTheDocument()
    await user.type(field('Host'), 'db.internal')
    await user.type(field('Service name'), 'FREEPDB1')
    await user.type(field('User'), 'monitor')
    await user.type(field('Password'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))
    await waitFor(() => expect(createdBody()).toBeDefined())
    expect(createdBody()).toMatchObject({ type: 'oracle', config: { host: 'db.internal', port: 1521, database: 'FREEPDB1', query: 'SELECT 1 FROM DUAL' } })
  })

  it('starts a new database monitor on verified TLS and shows the CA field only there', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.type(field('Name'), 'Secure DB')
    await pickType(user, 'Database')
    expect(field<HTMLSelectElement>('Connection security').value).toBe('verify')
    await user.type(field('CA certificate (optional)'), 'PEM')
    await user.type(field('Host'), 'db.internal')
    await user.type(field('Database'), 'orders')
    await user.type(field('User'), 'monitor')
    await user.type(field('Password'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))

    await waitFor(() => expect(createdBody()).toBeDefined())
    expect(createdBody()).toMatchObject({ config: { tls: 'verify', tlsCa: 'PEM' } })
  })

  it('warns when the certificate is not checked and hides the CA field', async () => {
    const user = userEvent.setup()
    renderModal()

    await pickType(user, 'Database')
    await user.selectOptions(field('Connection security'), 'require')
    expect(screen.getByText(/The certificate is not checked, so a party/)).toBeInTheDocument()
    expect(screen.queryByLabelText('CA certificate (optional)')).not.toBeInTheDocument()
    await user.selectOptions(field('Connection security'), 'prefer')
    expect(screen.queryByText(/falls back to plain text/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'PostgreSQL' }))
    expect(screen.getByText(/falls back to plain text/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'MongoDB' }))
    expect(screen.getByText(/MongoDB is not encrypted at all/)).toBeInTheDocument()
  })

  it('submits the expected result of a database query', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.type(field('Name'), 'Stuck queue')
    await pickType(user, 'Database')
    await user.type(field('Host'), 'sql.internal')
    await user.type(field('Database'), 'orders')
    await user.type(field('User'), 'monitor')
    await user.type(field('Password'), 'pw')
    await user.clear(field('Test Query'))
    await user.type(field('Test Query'), 'SELECT COUNT(*) FROM queue WHERE stuck = 1')
    await user.type(field('Expected Result (optional)'), '0')
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))

    await waitFor(() => expect(createdBody()).toBeDefined())
    expect(createdBody()).toMatchObject({
      config: { query: 'SELECT COUNT(*) FROM queue WHERE stuck = 1', expectedResult: '0' },
    })
  })

  it('opens the Credentials panel when Database is chosen and keeps a monitor without them from being saved', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.type(field('Name'), 'Orders DB')
    expect(screen.queryByText('User', { selector: 'label' })).not.toBeInTheDocument()
    await pickType(user, 'Database')
    expect(screen.getByText('User', { selector: 'label' })).toBeInTheDocument()

    await user.type(field('Host'), 'db.internal')
    await user.type(field('Database'), 'orders')
    await user.click(screen.getByRole('button', { name: 'Credentials' }))
    expect(screen.queryByText('User', { selector: 'label' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))
    expect(await screen.findByText('Enter the database user and password, or choose a secret from Vault.')).toBeInTheDocument()
    expect(screen.getByText('User', { selector: 'label' })).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('requires a vault for SQL Server connection strings', async () => {
    const user = userEvent.setup()
    renderModal()

    await pickType(user, 'Database')
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
    await user.click(screen.getByTitle('Checks'))
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

  it('turns on the slower-than-usual alert with its defaults and saves the settings typed in', async () => {
    const user = userEvent.setup()
    const { onSaved } = renderModal(existingMonitor())

    await user.click(screen.getByTitle('Latency'))
    expect(screen.queryByLabelText('Slower by (×)')).not.toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: /Alert when responses get slower than usual/ }))
    expect(field('Slower by (×)')).toHaveValue(3)
    expect(field('Measured over (minutes)')).toHaveValue(30)
    expect(field('At least slower by (ms)')).toHaveValue(200)
    expect(field('Confirm after (checks)')).toHaveValue(3)
    expect(screen.getByText(/The usual p95 is measured once the monitor has a day of results/)).toBeInTheDocument()

    await user.clear(field('Slower by (×)'))
    await user.type(field('Slower by (×)'), '2.5')
    await user.clear(field('Confirm after (checks)'))
    await user.type(field('Confirm after (checks)'), '5')
    // Leaving the field applies the value, so the next one is typed into a clean form.
    await user.tab()
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(api.patch).toHaveBeenCalledWith('/admin/monitors/2', expect.objectContaining({
      latencyAlertFactor: 2.5, latencyAlertWindowMinutes: 30, latencyAlertMinDeltaMs: 200, latencyAlertSustain: 5,
    }))
  })

  it('clamps a setting of the slower-than-usual alert into its range when the field is left', async () => {
    const user = userEvent.setup()
    renderModal(existingMonitor({ latencyAlertFactor: 3 }))
    await user.click(screen.getByTitle('Latency'))
    await user.clear(field('Slower by (×)'))
    await user.type(field('Slower by (×)'), '50')
    await user.tab()
    expect(field('Slower by (×)')).toHaveValue(10)
    await user.clear(field('Measured over (minutes)'))
    await user.tab()
    expect(field('Measured over (minutes)')).toHaveValue(30)
  })

  it('shows the usual p95 and where the alert fires once the baseline is known, and turns the alert off', async () => {
    const user = userEvent.setup()
    const { onSaved } = renderModal(existingMonitor({ latencyAlertFactor: 3, latencyBaselineP95: 150 }))
    expect(screen.getByTitle('Latency')).toBeInTheDocument()
    await user.click(screen.getByTitle('Latency'))
    expect(screen.getByText('150 ms')).toBeInTheDocument()
    expect(screen.getByText('450 ms')).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: /Alert when responses get slower than usual/ }))
    expect(screen.queryByLabelText('Slower by (×)')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(api.patch).toHaveBeenCalledWith('/admin/monitors/2', expect.objectContaining({ latencyAlertFactor: null }))
  })

  it.each([
    ['webhook', {}],
    ['domain', { domain: 'example.com', warnDays: 30 }],
    ['tls', { host: 'example.com', port: 443, warnDays: 21 }],
    ['docker', { container: 'web' }],
  ] as const)('has no latency tab for a %s monitor, whose response time is not the time a service took to answer', (type, config) => {
    renderModal(existingMonitor({ type, config: config as never }))
    expect(screen.queryByTitle('Latency')).not.toBeInTheDocument()
  })

  it.each(['https', 'ping', 'dns', 'postgresql', 'redis', 'mail', 'ssh'] as const)('has a latency tab for a %s monitor', (type) => {
    renderModal(existingMonitor({ type, config: { host: 'example.test' } as never }))
    expect(screen.getByTitle('Latency')).toBeInTheDocument()
  })

  it('turns the alert off in what it sends when the monitor is switched to a type without one', async () => {
    const user = userEvent.setup()
    const { onSaved } = renderModal(existingMonitor({ latencyAlertFactor: 3 }))
    await pickType(user, 'Domain expiry')
    expect(screen.queryByTitle('Latency')).not.toBeInTheDocument()
    await user.type(field('Domain'), 'example.com')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(api.patch).toHaveBeenCalledWith('/admin/monitors/2', expect.objectContaining({ type: 'domain', latencyAlertFactor: null }))
  })

  it('links an action to the monitor for admins and saves the links with it', async () => {
    const user = userEvent.setup()
    mockGets({
      '/admin/actions': [{ id: 9, name: 'Start VM2', enabled: 1, config: { url: 'https://jenkins.test/build', method: 'POST' } }],
      '/admin/actions/monitor/2': [{ actionId: 9, onStatus: 'up', delayMinutes: 0, cooldownMinutes: 0 }],
    })
    const { onSaved } = renderModal(existingMonitor())

    await user.click(await screen.findByTitle('Actions'))
    expect(await screen.findByLabelText('Action 1')).toHaveValue('9')
    await user.click(screen.getByRole('button', { name: '+ Add action' }))
    await user.type(within(screen.getByLabelText('Action 2').closest('div')!.parentElement!).getAllByRole('spinbutton')[0]!, '10')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(api.put).toHaveBeenCalledWith('/admin/actions/monitor/2', { actions: [
      { actionId: 9, onStatus: 'up', delayMinutes: 0, cooldownMinutes: 0 },
      { actionId: 9, onStatus: 'down', delayMinutes: 10, cooldownMinutes: 0 },
    ] })
  })

  it('hides the actions tab and leaves the links alone when the user cannot manage actions', async () => {
    const user = userEvent.setup()
    mockGets({ '/admin/notifications/monitor/2/channels': [], '/admin/monitors/2/dependencies': { dependsOnIds: [] } })
    const { onSaved } = renderModal(existingMonitor())

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/actions'))
    expect(screen.queryByTitle('Actions')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(vi.mocked(api.put).mock.calls.some(([path]) => String(path).startsWith('/admin/actions'))).toBe(false)
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

  it('drops what was typed in directly when the credentials come from a vault instead', async () => {
    mockGets({
      '/admin/notifications/monitor/2/channels': [],
      '/admin/monitors/2/dependencies': { dependsOnIds: [] },
    })
    const user = userEvent.setup()
    const { onSaved } = renderModal(existingMonitor({
      config: { url: 'https://edge.example.test', method: 'GET', expectedStatus: 200, auth: { type: 'basic', basic: { username: 'svc', password: '••••••••' } } },
    }))

    await user.click(screen.getByTitle('Auth'))
    await user.click(screen.getByRole('button', { name: 'From Vault' }))
    await user.selectOptions(field<HTMLSelectElement>('Secret'), '11')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    const body = vi.mocked(api.patch).mock.calls[0]![1] as { config: { auth: { basic: Record<string, unknown> } } }
    expect(body.config.auth.basic).toEqual({ vault: { vaultId: 7, secretId: 11, fieldMapping: {} } })
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
    await pickType(user, 'Webhook')
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

  it('names the saved monitor when testing an edit, so a masked secret is tested as stored', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({ overall: 'ok', totalMs: 5, steps: [] })
    renderModal(existingMonitor({ id: 9 }))

    await user.click(screen.getByRole('button', { name: /Test$/ }))

    expect(vi.mocked(api.post).mock.calls[0]?.[0]).toBe('/admin/monitors/test')
    expect(vi.mocked(api.post).mock.calls[0]?.[1]).toMatchObject({ type: 'https', monitorId: 9 })
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

describe('MonitorFormModal YAML view', () => {
  beforeEach(() => { vi.clearAllMocks(); mockGets() })

  it('opens the saved monitor as YAML, by its key', async () => {
    const user = userEvent.setup()
    renderModal(existingMonitor())
    await user.click(screen.getByRole('button', { name: 'YAML' }))
    expect(screen.getByRole('dialog', { name: 'YAML view' })).toHaveTextContent('Monitor edge')
    await user.click(screen.getByRole('button', { name: 'Close YAML' }))
    expect(screen.queryByRole('dialog', { name: 'YAML view' })).not.toBeInTheDocument()
  })

  it('has no YAML for a monitor that does not exist yet', () => {
    renderModal(null)
    expect(screen.queryByRole('button', { name: 'YAML' })).not.toBeInTheDocument()
  })
})

describe('MonitorFormModal service monitors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGets()
    vi.mocked(api.post).mockResolvedValue({ id: 42 })
    vi.mocked(api.put).mockResolvedValue({})
  })

  it('creates a Redis monitor with its credentials from the Credentials tab', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.type(field('Name'), 'Cache')
    await pickType(user, 'Redis')
    expect(field('Port')).toHaveValue(6379)
    await user.type(field('Host'), 'cache.example.test')
    await user.click(screen.getByLabelText('Connect over TLS'))
    expect(screen.getByLabelText('Verify the server certificate and host name')).toBeChecked()
    await user.click(screen.getByTitle('Credentials'))
    await user.type(field('User'), 'alice')
    await user.type(field('Password'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))

    await waitFor(() => expect(createdBody()).toBeDefined())
    expect(createdBody()).toMatchObject({ type: 'redis', config: { host: 'cache.example.test', port: 6379, tls: true, username: 'alice', password: 'pw' } })
    expect(createdBody()['config']).not.toHaveProperty('user')
  })

  it('creates a Redis monitor without any account', async () => {
    const user = userEvent.setup()
    renderModal()
    await user.type(field('Name'), 'Open cache')
    await pickType(user, 'Redis')
    await user.type(field('Host'), 'cache.example.test')
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))
    await waitFor(() => expect(createdBody()).toBeDefined())
    expect(createdBody()['config']).toEqual({ host: 'cache.example.test', port: 6379 })
  })

  it('moves the mail port with the protocol and encryption while it holds a default', async () => {
    const user = userEvent.setup()
    renderModal()
    await pickType(user, 'Mail server')
    expect(field('Port')).toHaveValue(587)

    await user.selectOptions(field<HTMLSelectElement>('Protocol'), 'imap')
    expect(field('Port')).toHaveValue(143)
    await user.selectOptions(field<HTMLSelectElement>('Encryption'), 'tls')
    expect(field('Port')).toHaveValue(993)

    await user.clear(field('Port'))
    await user.type(field('Port'), '1993')
    await user.selectOptions(field<HTMLSelectElement>('Protocol'), 'pop3')
    expect(field('Port')).toHaveValue(1993)

    await user.selectOptions(field<HTMLSelectElement>('Encryption'), 'none')
    expect(screen.queryByLabelText('Verify the server certificate and host name')).not.toBeInTheDocument()
  })

  it('warns when a mail account would be sent unencrypted', async () => {
    const user = userEvent.setup()
    renderModal()
    await pickType(user, 'Mail server')
    await user.selectOptions(field<HTMLSelectElement>('Encryption'), 'none')
    expect(screen.queryByText(/sent unencrypted/)).not.toBeInTheDocument()
    await user.click(screen.getByTitle('Credentials'))
    await user.type(field('Password'), 'pw')
    expect(screen.getByText(/sent unencrypted/)).toBeInTheDocument()
  })

  it('submits a mail monitor that signs in and does not verify the certificate', async () => {
    const user = userEvent.setup()
    renderModal()
    await user.type(field('Name'), 'Mailbox')
    await pickType(user, 'Mail server')
    await user.type(field('Host'), 'mail.example.test')
    await user.click(screen.getByLabelText('Verify the server certificate and host name'))
    expect(screen.getByText(/Any certificate is accepted/)).toBeInTheDocument()
    await user.click(screen.getByTitle('Credentials'))
    await user.type(field('User'), 'me')
    await user.type(field('Password'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))

    await waitFor(() => expect(createdBody()).toBeDefined())
    expect(createdBody()).toMatchObject({
      type: 'mail',
      config: { protocol: 'smtp', host: 'mail.example.test', port: 587, security: 'starttls', verifyTls: false, username: 'me', password: 'pw' },
    })
  })

  it('submits SSH, TLS certificate and domain expiry monitors', async () => {
    const user = userEvent.setup()
    renderModal()
    await user.type(field('Name'), 'Checks')

    await pickType(user, 'SSH')
    expect(field('Port')).toHaveValue(22)
    await user.type(field('Host'), 'ssh.example.test')
    await user.type(field('Expected identification text (optional)'), 'OpenSSH')
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))
    await waitFor(() => expect(createdBody()).toBeDefined())
    expect(createdBody()).toMatchObject({ type: 'ssh', config: { host: 'ssh.example.test', port: 22, expectedBanner: 'OpenSSH' } })

    vi.mocked(api.post).mockClear()
    await pickType(user, 'TLS certificate')
    expect(field('Port')).toHaveValue(443)
    await user.type(field('Host'), 'example.test')
    await user.clear(field('Degraded within (days)'))
    await user.type(field('Degraded within (days)'), '21')
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))
    await waitFor(() => expect(createdBody()).toBeDefined())
    expect(createdBody()).toMatchObject({ type: 'tls', config: { host: 'example.test', port: 443, warnDays: 21 } })

    vi.mocked(api.post).mockClear()
    await pickType(user, 'Domain expiry')
    await user.type(field('Domain'), 'example.test')
    await user.click(screen.getByRole('button', { name: 'Create Monitor' }))
    await waitFor(() => expect(createdBody()).toBeDefined())
    expect(createdBody()).toMatchObject({ type: 'domain', config: { domain: 'example.test', warnDays: 30 } })
  })

  it('puts the default of the type back when the days to warn are cleared and left', async () => {
    const user = userEvent.setup()
    renderModal()
    await pickType(user, 'TLS certificate')
    expect(field('Degraded within (days)')).toHaveValue(14)
    await user.clear(field('Degraded within (days)'))
    await user.tab()
    expect(field('Degraded within (days)')).toHaveValue(14)

    await pickType(user, 'Domain expiry')
    expect(field('Degraded within (days)')).toHaveValue(30)
    await user.clear(field('Degraded within (days)'))
    await user.tab()
    expect(field('Degraded within (days)')).toHaveValue(30)
  })

  it('tests the new types through the test endpoint', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValue({ overall: 'ok', steps: [{ label: 'SSH host:22', status: 'ok', detail: 'SSH-2.0-OpenSSH_9.6' }], totalMs: 5 })
    renderModal()
    await pickType(user, 'SSH')
    await user.type(field('Host'), 'ssh.example.test')
    await user.click(screen.getByRole('button', { name: /Test$/ }))
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledWith('/admin/monitors/test', expect.objectContaining({ type: 'ssh' })))
    expect(await screen.findByText('SSH-2.0-OpenSSH_9.6')).toBeInTheDocument()
  })

  it('keeps the Credentials tab when switching between Redis and mail, and drops it for other types', async () => {
    const user = userEvent.setup()
    renderModal()
    await pickType(user, 'Redis')
    await user.click(screen.getByTitle('Credentials'))
    expect(screen.getByText('Credentials', { selector: 'h2, h3, span, div' })).toBeInTheDocument()
    await pickType(user, 'Mail server')
    expect(screen.getByTitle('Credentials')).toBeInTheDocument()
    await pickType(user, 'SSH')
    expect(screen.queryByTitle('Credentials')).not.toBeInTheDocument()
  })
})
