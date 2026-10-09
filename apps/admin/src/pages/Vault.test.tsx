import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { ToastProvider } from '../components/ui'
import VaultPage from './Vault'

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

const vaults = [
  { id: 1, name: 'Production', type: 'local', description: 'Prod credentials', createdAt: 1, updatedAt: 1 },
  { id: 2, name: 'Staging', type: 'local', description: null, createdAt: 1, updatedAt: 1 },
]

const secrets = [
  { id: 10, vaultId: 1, name: 'db-login', type: 'userpass', createdAt: 1, updatedAt: Date.UTC(2026, 8, 1) },
  { id: 11, vaultId: 1, name: 'api-token', type: 'value', createdAt: 1, updatedAt: Date.UTC(2026, 8, 1) },
  { id: 12, vaultId: 1, name: 'config-blob', type: 'json', createdAt: 1, updatedAt: Date.UTC(2026, 8, 1) },
]

let vaultList: unknown[] = vaults
let secretList: unknown[] = secrets

function mockGets() {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/vaults') return vaultList
    if (path === '/admin/vaults/1/secrets') return secretList
    if (path === '/admin/vaults/2/secrets') return []
    if (path === '/admin/vaults/1/secrets/10/reveal') {
      return { id: 10, name: 'db-login', type: 'userpass', value: { username: 'dbadmin', password: 'hunter2-s3cret' } }
    }
    if (path === '/admin/vaults/1/secrets/11/reveal') {
      return { id: 11, name: 'api-token', type: 'value', value: { value: 'tok_abc123' } }
    }
    if (path === '/admin/vaults/1/secrets/12/reveal') {
      return { id: 12, name: 'config-blob', type: 'json', value: { value: '{"region":"eu"}' } }
    }
    throw new Error(`Unexpected GET ${path}`)
  })
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><VaultPage /></QueryClientProvider>)
}

async function openVault(user: ReturnType<typeof userEvent.setup>, name = 'Production') {
  await user.click(await screen.findByText(name))
}

describe('VaultPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vaultList = vaults
    secretList = secrets
    mockGets()
    vi.mocked(api.post).mockResolvedValue({})
    vi.mocked(api.delete).mockResolvedValue(undefined)
  })

  it('lists vaults and asks to select one before showing secrets', async () => {
    renderPage()

    expect(await screen.findByText('Production')).toBeInTheDocument()
    expect(screen.getByText('Staging')).toBeInTheDocument()
    expect(screen.getByText('2 vaults')).toBeInTheDocument()
    expect(screen.getByText('Select a vault to view its secrets')).toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining('/secrets'))
  })

  it('shows an empty state without vaults', async () => {
    vaultList = []
    renderPage()

    expect(await screen.findByText('No vaults yet')).toBeInTheDocument()
    expect(screen.getByText('0 vaults')).toBeInTheDocument()
  })

  it('lists secret names and types without fetching any secret value', async () => {
    const user = userEvent.setup()
    renderPage()

    await openVault(user)

    expect(await screen.findByText('db-login')).toBeInTheDocument()
    expect(screen.getByText('api-token')).toBeInTheDocument()
    expect(screen.getByText('config-blob')).toBeInTheDocument()
    expect(screen.getByText('Prod credentials', { selector: 'p.text-sm' })).toBeInTheDocument()
    expect(screen.getByText(/^User\/Pass · Updated/)).toBeInTheDocument()
    // Values are only ever fetched on an explicit Reveal.
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining('/reveal'))
    expect(screen.queryByText('hunter2-s3cret')).not.toBeInTheDocument()
  })

  it('shows an empty secrets state for a vault without secrets', async () => {
    const user = userEvent.setup()
    renderPage()

    await openVault(user, 'Staging')

    expect(await screen.findByText('No secrets in this vault')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add a secret' }))
    expect(screen.getByRole('dialog', { name: 'New Secret' })).toBeInTheDocument()
  })

  it('creates a vault and selects it', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({ id: 2, name: 'Staging', type: 'local', description: null, createdAt: 1, updatedAt: 1 })
    renderPage()

    await user.click(await screen.findByTitle('Create vault'))
    const dialog = screen.getByRole('dialog', { name: 'Create Vault' })
    await user.type(within(dialog).getByPlaceholderText('My Credentials'), 'Staging')
    await user.click(within(dialog).getByRole('button', { name: 'Create Vault' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/vaults', { name: 'Staging', description: undefined }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText('No secrets in this vault')).toBeInTheDocument()
  })

  it('keeps the create-vault dialog open with the server error', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Vault name already exists'))
    renderPage()

    await user.click(await screen.findByTitle('Create vault'))
    const dialog = screen.getByRole('dialog', { name: 'Create Vault' })
    await user.type(within(dialog).getByPlaceholderText('My Credentials'), 'Production')
    await user.type(within(dialog).getByPlaceholderText('What this vault stores…'), 'dup')
    await user.click(within(dialog).getByRole('button', { name: 'Create Vault' }))

    expect(await within(dialog).findByText('Vault name already exists')).toBeInTheDocument()
    expect(api.post).toHaveBeenCalledWith('/admin/vaults', { name: 'Production', description: 'dup' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('submits a user/password secret with a masked password input', async () => {
    const user = userEvent.setup()
    renderPage()

    await openVault(user)
    await user.click(await screen.findByRole('button', { name: /New Secret/ }))
    const dialog = screen.getByRole('dialog', { name: 'New Secret' })
    await user.type(within(dialog).getByPlaceholderText('my-api-key'), 'smtp-login')
    await user.type(within(dialog).getByPlaceholderText('admin'), 'mailer')
    const password = within(dialog).getByPlaceholderText('••••••••')
    expect(password).toHaveAttribute('type', 'password')
    await user.type(password, 'p@ss')
    await user.click(within(dialog).getByRole('button', { name: 'Save Secret' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/vaults/1/secrets', {
      name: 'smtp-login',
      type: 'userpass',
      userpass: { username: 'mailer', password: 'p@ss' },
    }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // After saving, the secret value is never rendered back on the page.
    expect(screen.queryByText('p@ss')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('p@ss')).not.toBeInTheDocument()
  })

  it('submits a secure value secret', async () => {
    const user = userEvent.setup()
    renderPage()

    await openVault(user)
    await user.click(await screen.findByRole('button', { name: /New Secret/ }))
    const dialog = screen.getByRole('dialog', { name: 'New Secret' })
    await user.type(within(dialog).getByPlaceholderText('my-api-key'), 'token')
    await user.click(within(dialog).getByRole('button', { name: /Secure Value/ }))
    await user.type(within(dialog).getByPlaceholderText('Bearer eyJ…'), 'abc')
    await user.click(within(dialog).getByRole('button', { name: 'Save Secret' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/vaults/1/secrets', { name: 'token', type: 'value', value: 'abc' }))
  })

  it('refuses to submit invalid JSON and submits valid JSON', async () => {
    const user = userEvent.setup()
    renderPage()

    await openVault(user)
    await user.click(await screen.findByRole('button', { name: /New Secret/ }))
    const dialog = screen.getByRole('dialog', { name: 'New Secret' })
    await user.type(within(dialog).getByPlaceholderText('my-api-key'), 'cfg')
    await user.click(within(dialog).getByRole('button', { name: /^JSON/ }))
    const jsonInput = within(dialog).getByPlaceholderText(/"key": "value"/)
    await user.type(jsonInput, '{{bad')
    expect(within(dialog).getByText('Invalid JSON')).toBeInTheDocument()
    expect(within(dialog).getByRole('textbox', { name: /JSON/ })).toHaveAttribute('aria-invalid', 'true')
    await user.click(within(dialog).getByRole('button', { name: 'Save Secret' }))
    expect(api.post).not.toHaveBeenCalled()

    await user.clear(jsonInput)
    await user.type(jsonInput, '{{"a":1}')
    expect(within(dialog).queryByText(/Invalid JSON/)).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Save Secret' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/vaults/1/secrets', { name: 'cfg', type: 'json', json: '{"a":1}' }))
  })

  it('shows the server error when saving a secret fails', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Secret name taken'))
    renderPage()

    await openVault(user)
    await user.click(await screen.findByRole('button', { name: /New Secret/ }))
    const dialog = screen.getByRole('dialog', { name: 'New Secret' })
    await user.type(within(dialog).getByPlaceholderText('my-api-key'), 'db-login')
    await user.type(within(dialog).getByPlaceholderText('admin'), 'u')
    await user.type(within(dialog).getByPlaceholderText('••••••••'), 'p')
    await user.click(within(dialog).getByRole('button', { name: 'Save Secret' }))

    expect(await within(dialog).findByText('Secret name taken')).toBeInTheDocument()
  })

  it('reveals a user/password secret with the password blurred until shown', async () => {
    const user = userEvent.setup()
    renderPage()

    await openVault(user)
    await user.click((await screen.findAllByRole('button', { name: /Reveal/ }))[0]!)

    const dialog = await screen.findByRole('dialog', { name: 'db-login' })
    expect(api.get).toHaveBeenCalledWith('/admin/vaults/1/secrets/10/reveal')
    expect(within(dialog).getByText('dbadmin')).toBeInTheDocument()
    const password = within(dialog).getByText('hunter2-s3cret')
    expect(password).toHaveStyle({ filter: 'blur(6px)' })
    // Only the username can be copied while the password is hidden.
    expect(within(dialog).getAllByRole('button', { name: /^Copy/ })).toHaveLength(1)

    await user.click(within(dialog).getByRole('button', { name: 'Show' }))
    expect(password).toHaveStyle({ filter: 'none' })
    expect(within(dialog).getAllByRole('button', { name: /^Copy/ })).toHaveLength(2)
    await user.click(within(dialog).getByRole('button', { name: 'Hide' }))
    expect(password).toHaveStyle({ filter: 'blur(6px)' })

    await user.click(within(dialog).getByText('Close', { selector: 'button' }))
    expect(screen.queryByText('hunter2-s3cret')).not.toBeInTheDocument()
  })

  it('reveals value and JSON secrets', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderPage()

    await openVault(user)
    await user.click((await screen.findAllByRole('button', { name: /Reveal/ }))[1]!)
    const valueDialog = await screen.findByRole('dialog', { name: 'api-token' })
    expect(within(valueDialog).getByText('tok_abc123')).toBeInTheDocument()
    await user.click(within(valueDialog).getByRole('button', { name: 'Copy value' }))
    expect(writeText).toHaveBeenCalledWith('tok_abc123')
    await user.click(within(valueDialog).getByText('Close', { selector: 'button' }))

    await user.click(screen.getAllByRole('button', { name: /Reveal/ })[2]!)
    const jsonDialog = await screen.findByRole('dialog', { name: 'config-blob' })
    expect(jsonDialog.querySelector('pre')).toHaveTextContent('"region": "eu"')
  })

  it('deletes a secret only after confirmation', async () => {
    const user = userEvent.setup()
    renderPage()

    await openVault(user)
    await screen.findByText('db-login')
    await user.click(screen.getByRole('button', { name: 'Delete secret db-login' }))
    expect(screen.getByText('Delete secret "db-login"? This action cannot be undone.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.delete).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete secret db-login' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Delete secret' })).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/vaults/1/secrets/10'))
  })

  it('requires acknowledging secret loss before deleting a vault that holds secrets', async () => {
    const user = userEvent.setup()
    renderPage()

    await openVault(user)
    await screen.findByText('db-login')
    await user.click(screen.getByRole('button', { name: 'Delete vault Production' }))

    const dialog = screen.getByRole('dialog', { name: 'Delete vault' })
    expect(within(dialog).getByText('This vault contains 3 secrets. All secrets will be permanently deleted.')).toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: 'Delete vault' })
    expect(confirm).toBeDisabled()
    await user.click(within(dialog).getByRole('checkbox'))
    expect(confirm).toBeEnabled()
    await user.click(confirm)

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/vaults/1'))
    expect(await screen.findByText('Select a vault to view its secrets')).toBeInTheDocument()
  })

  it('warns that an unopened vault may hold secrets and can be cancelled', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Staging')
    await user.click(screen.getByRole('button', { name: 'Delete vault Staging' }))

    const dialog = screen.getByRole('dialog', { name: 'Delete vault' })
    expect(within(dialog).getByText('This vault may contain secrets. All secrets will be permanently deleted.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.delete).not.toHaveBeenCalled()
  })

  it('reports a failed reveal instead of failing silently', async () => {
    const user = userEvent.setup()
    const base = vi.mocked(api.get).getMockImplementation()!
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.endsWith('/reveal')) throw new Error('Vault key missing')
      return base(path)
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<ToastProvider><QueryClientProvider client={queryClient}><VaultPage /></QueryClientProvider></ToastProvider>)

    await openVault(user)
    await user.click((await screen.findAllByRole('button', { name: /Reveal/ }))[0]!)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reveal "db-login": Vault key missing')
    expect(screen.getAllByRole('button', { name: /Reveal/ })[0]).toBeEnabled()
  })

  it('shows malformed JSON secrets as plain text instead of crashing', async () => {
    const user = userEvent.setup()
    const base = vi.mocked(api.get).getMockImplementation()!
    vi.mocked(api.get).mockImplementation(async (path: string) => (
      path === '/admin/vaults/1/secrets/12/reveal'
        ? { id: 12, name: 'config-blob', type: 'json', value: { value: '{not json' } }
        : base(path)
    ))
    renderPage()

    await openVault(user)
    await user.click((await screen.findAllByRole('button', { name: /Reveal/ }))[2]!)
    const dialog = await screen.findByRole('dialog', { name: 'config-blob' })
    expect(dialog.querySelector('pre')).toHaveTextContent('{not json')
    expect(within(dialog).getByText(/not valid JSON/)).toBeInTheDocument()
  })

  it('shows a loading state instead of an empty vault while secrets load', async () => {
    const user = userEvent.setup()
    const base = vi.mocked(api.get).getMockImplementation()!
    vi.mocked(api.get).mockImplementation((path: string) => (
      path === '/admin/vaults/1/secrets' ? new Promise(() => {}) : base(path)
    ))
    renderPage()

    await openVault(user)
    expect(screen.getByText('Loading secrets…')).toBeInTheDocument()
    expect(screen.queryByText('No secrets in this vault')).not.toBeInTheDocument()
  })

  it('selects vaults with the keyboard', async () => {
    const user = userEvent.setup()
    renderPage()

    const production = await screen.findByRole('button', { name: /^Production/ })
    production.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('db-login')).toBeInTheDocument()
    expect(production).toHaveAttribute('aria-current', 'true')
  })
})

describe('VaultPage with a HashiCorp vault', () => {
  const hashicorpVault = { id: 3, name: 'Corporate Vault', type: 'hashicorp', description: null, createdAt: 1, updatedAt: 1 }
  const connection = {
    address: 'https://vault.example.com:8200', namespace: 'team-a', mount: 'secret', authMethod: 'token',
    approleMount: 'approle', roleId: '', caCert: '', hasToken: true, hasSecretId: false,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/vaults') return [...vaults, hashicorpVault]
      if (path === '/admin/vaults/1/secrets') return secrets
      if (path === '/admin/vaults/3/secrets') return [{ id: 30, vaultId: 3, name: 'db', type: 'userpass', createdAt: 1, updatedAt: 1 }]
      if (path === '/admin/vaults/3') return { ...hashicorpVault, connection }
      if (path === '/admin/vaults/3/secrets/30/reveal') {
        return { id: 30, name: 'db', type: 'userpass', value: { username: 'svc', password: 'pw' }, source: { path: 'bsp/db' } }
      }
      throw new Error(`Unexpected GET ${path}`)
    })
    vi.mocked(api.post).mockResolvedValue({})
    vi.mocked(api.patch).mockResolvedValue({})
  })

  it('creates a HashiCorp vault with a token connection', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Create vault' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/Vault name/), 'Corporate Vault')
    await user.click(within(dialog).getByRole('button', { name: /HashiCorp Vault/ }))
    await user.type(within(dialog).getByLabelText(/^Address/), 'http://vault:8200')
    expect(within(dialog).getByText(/sent unencrypted over http/)).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText(/^Token/), 's.token')
    await user.click(within(dialog).getByRole('button', { name: 'Create Vault' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/vaults', expect.objectContaining({
      name: 'Corporate Vault',
      type: 'hashicorp',
      connection: expect.objectContaining({ address: 'http://vault:8200', mount: 'secret', authMethod: 'token', token: 's.token' }),
    })))
  })

  it('sends no connection for a local vault', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Create vault' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/Vault name/), 'Plain')
    await user.click(within(dialog).getByRole('button', { name: 'Create Vault' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/vaults', { name: 'Plain', description: undefined }))
  })

  it('adds a secret reference with a path, and a key only for Secure Value', async () => {
    const user = userEvent.setup()
    renderPage()
    await openVault(user, 'Corporate Vault')
    await user.click(await screen.findByRole('button', { name: /New Secret/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByLabelText(/^Key/)).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText(/^Password/)).not.toBeInTheDocument()
    await user.type(within(dialog).getByLabelText(/Secret name/), 'api')
    await user.click(within(dialog).getByRole('button', { name: /Secure Value/ }))
    await user.type(within(dialog).getByLabelText(/^Path/), 'bsp/db')
    await user.type(within(dialog).getByLabelText(/^Key/), 'api_key')
    await user.click(within(dialog).getByRole('button', { name: 'Save Secret' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/vaults/3/secrets', { name: 'api', type: 'value', path: 'bsp/db', key: 'api_key' }))
  })

  it('shows where a revealed value came from', async () => {
    const user = userEvent.setup()
    renderPage()
    await openVault(user, 'Corporate Vault')
    await user.click(await screen.findByRole('button', { name: /Reveal/ }))
    const dialog = await screen.findByRole('dialog', { name: 'db' })
    expect(within(dialog).getByText(/Source: bsp\/db/)).toBeInTheDocument()
  })

  it('tests the connection and reports the result', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({ ok: true, ttlSeconds: 900 })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<ToastProvider><QueryClientProvider client={queryClient}><VaultPage /></QueryClientProvider></ToastProvider>)
    await openVault(user, 'Corporate Vault')
    await user.click(await screen.findByRole('button', { name: /Test connection/ }))
    expect(await screen.findByText(/Connected to HashiCorp Vault. Token valid for 900 s/)).toBeInTheDocument()
    expect(api.post).toHaveBeenCalledWith('/admin/vaults/3/test')

    vi.mocked(api.post).mockRejectedValueOnce(new Error('permission denied (HTTP 403)'))
    await user.click(screen.getByRole('button', { name: /Test connection/ }))
    expect(await screen.findByText(/Connection failed: permission denied/)).toBeInTheDocument()
  })

  it('saves connection settings without resending stored credentials', async () => {
    const user = userEvent.setup()
    renderPage()
    await openVault(user, 'Corporate Vault')
    await user.click(await screen.findByRole('button', { name: /Connection settings/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Connection settings' })
    const mount = await within(dialog).findByLabelText(/KV v2 mount/)
    await user.clear(mount)
    await user.type(mount, 'kv')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/vaults/3', {
      connection: expect.objectContaining({ address: connection.address, mount: 'kv', token: '', secretId: '' }),
    }))
  })

  it('only offers HashiCorp tools on HashiCorp vaults', async () => {
    const user = userEvent.setup()
    renderPage()
    await openVault(user)
    await screen.findByText('db-login')
    expect(screen.queryByRole('button', { name: /Test connection/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Connection settings/ })).not.toBeInTheDocument()
  })
})
