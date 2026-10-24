import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Action } from '@bsp/shared'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import ActionsPage from './Actions'

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

const actions = [
  { id: 1, name: 'Start VM2', enabled: 1, config: { url: 'https://jenkins.test/job/vm2/build', method: 'POST', headers: { Authorization: '••••••••' } } },
  { id: 2, name: 'Stop VM2', enabled: 0, config: { url: 'https://jenkins.test/job/stop-vm2/build', method: 'POST' } },
] as unknown as Action[]

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter><ActionsPage /></MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/actions') return actions
    throw new Error(`Unexpected GET ${path}`)
  })
})

describe('Actions page', () => {
  it('lists actions with their request and state, and links to the run history', async () => {
    renderPage()

    const row = (await screen.findByRole('button', { name: 'Edit Start VM2' })).closest('tr')!
    expect(within(row).getByText('POST https://jenkins.test/job/vm2/build')).toBeInTheDocument()
    expect(within(row).getByText('Active')).toBeInTheDocument()
    expect(within(screen.getByRole('button', { name: 'Edit Stop VM2' }).closest('tr')!).getByText('Disabled')).toBeInTheDocument()

    expect(screen.getByRole('link', { name: /Run history/ })).toHaveAttribute('href', '/admin/delivery-history?tab=actions')
  })

  it('creates an action through the form', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValue({})
    renderPage()
    await screen.findByRole('button', { name: 'Edit Start VM2' })

    await user.click(screen.getByRole('button', { name: /Add Action/ }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByPlaceholderText('My action'), 'Wake VM3')
    await user.type(within(dialog).getByPlaceholderText('https://example.com/alert'), 'https://jenkins.test/job/vm3/build')
    await user.click(within(dialog).getByRole('button', { name: 'Create Action' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/actions', expect.objectContaining({
      name: 'Wake VM3', enabled: 1, config: expect.objectContaining({ url: 'https://jenkins.test/job/vm3/build', method: 'POST' }),
    })))
  })

  it('deletes an action after confirmation', async () => {
    const user = userEvent.setup()
    vi.mocked(api.delete).mockResolvedValue(undefined)
    renderPage()
    await screen.findByRole('button', { name: 'Edit Start VM2' })

    await user.click(screen.getByRole('button', { name: 'Delete Start VM2' }))
    await user.click(await screen.findByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/actions/1'))
  })
})

describe('Action form', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/actions') return actions.map((action) => ({ ...action, notificationChannelIds: [] }))
      if (path === '/admin/notifications/channels') return [{ id: 3, name: 'Ops Slack', type: 'slack', enabled: 1 }, { id: 4, name: 'Old mail', type: 'email', enabled: 0 }]
      if (path === '/admin/vaults') return [{ id: 7, name: 'Jenkins' }]
      if (path === '/admin/vaults/7/secrets') return [{ id: 70, name: 'api-token', type: 'value' }, { id: 71, name: 'json-thing', type: 'json' }]
      throw new Error(`Unexpected GET ${path}`)
    })
  })

  async function openEdit(user: ReturnType<typeof userEvent.setup>) {
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Edit Start VM2' }))
    return screen.findByRole('dialog')
  }

  it('shows the status and the answer of Run now, for a success and for a failure', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({ ok: true, status: 201, snippet: 'queued' })
    const dialog = await openEdit(user)

    await user.click(within(dialog).getByRole('button', { name: /Run now/ }))
    expect(await within(dialog).findByText(/answered with HTTP 201/)).toBeInTheDocument()
    expect(within(dialog).getByText('queued')).toBeInTheDocument()

    vi.mocked(api.post).mockRejectedValueOnce(Object.assign(new Error('HTTP 500: Job queue is full'), { body: { error: 'HTTP 500: Job queue is full', status: 500, snippet: 'Job queue is full' } }))
    await user.click(within(dialog).getByRole('button', { name: /Run now/ }))
    expect(await within(dialog).findByText('Job queue is full')).toBeInTheDocument()
  })

  it('saves the channels told about a run', async () => {
    const user = userEvent.setup()
    vi.mocked(api.patch).mockResolvedValue({})
    const dialog = await openEdit(user)
    await user.click(within(dialog).getByTitle('Notifications'))
    await user.click(await within(dialog).findByRole('checkbox', { name: /Ops Slack/ }))
    expect(within(dialog).getByText('disabled')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/actions/1', expect.objectContaining({ notificationChannelIds: [3] })))
  })

  it('warns about a credential typed in plain text, and saves several named vault secrets', async () => {
    const user = userEvent.setup()
    vi.mocked(api.patch).mockResolvedValue({})
    const dialog = await openEdit(user)
    expect(within(dialog).getByText(/looks like it holds a credential in plain text/)).toBeInTheDocument()

    await user.click(within(dialog).getByTitle('Secrets'))
    await user.click(within(dialog).getByRole('button', { name: '+ Add secret' }))
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Vault' }), '7')
    await user.selectOptions(await within(dialog).findByRole('combobox', { name: 'Secret' }), '70')
    expect(within(dialog).getByText('{{secret_token}}')).toBeInTheDocument()
    expect(within(dialog).queryByText(/looks like it holds a credential in plain text/)).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '+ Add secret' }))
    const names = within(dialog).getAllByPlaceholderText('token')
    expect(names[1]).toHaveValue('token2')
    await user.clear(names[1]!)
    await user.type(names[1]!, 'login')
    await user.selectOptions(within(dialog).getAllByRole('combobox', { name: 'Vault' })[1]!, '7')
    await user.selectOptions(await within(dialog).findAllByRole('combobox', { name: 'Secret' }).then((all) => all[1]!), '71')
    expect(within(dialog).getByText('{{secret_login_<key>}}')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/actions/1', expect.objectContaining({
      config: expect.objectContaining({ secrets: [
        { name: 'token', vault: { vaultId: 7, secretId: 70 } },
        { name: 'login', vault: { vaultId: 7, secretId: 71 } },
      ] }),
    })))
  })

  it('does not save a secret that has no vault secret chosen, or a name used twice', async () => {
    const user = userEvent.setup()
    const dialog = await openEdit(user)
    await user.click(within(dialog).getByTitle('Secrets'))
    await user.click(within(dialog).getByRole('button', { name: '+ Add secret' }))

    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }))

    expect(await within(dialog).findByText(/Choose a vault secret for "token"/)).toBeInTheDocument()
    expect(api.patch).not.toHaveBeenCalled()
  })
})
