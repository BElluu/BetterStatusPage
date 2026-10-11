import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import ApiTokensPage from './ApiTokens'

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

const token = {
  id: 7, name: 'Deploy', prefix: 'bsp_Ab12Cd', scopes: ['monitors:read', 'monitors:write', 'incidents:read', 'vault:use'],
  createdBy: 'admin@example.test', createdAt: 1, expiresAt: null, lastUsedAt: null,
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><ApiTokensPage /></QueryClientProvider>)
}

const checkbox = (name: string) => screen.getByRole('checkbox', { name })

describe('ApiTokensPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue([token])
  })

  it('lists tokens by prefix with their permissions, never the secret', async () => {
    renderPage()
    expect(await screen.findByText('Deploy')).toBeInTheDocument()
    expect(screen.getByText('bsp_Ab12Cd…')).toBeInTheDocument()
    const permissions = within(screen.getByRole('list', { name: 'Permissions of Deploy' }))
    expect(permissions.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Monitors · write', 'Incidents · read', 'Vault secrets'])
    expect(screen.getByText('admin@example.test')).toBeInTheDocument()
  })

  it('creates a token with the ticked permissions, expiring in 90 days by default, and shows the secret once', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({ ...token, id: 8, name: 'GitHub Actions', token: 'bsp_full-secret-value' })
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New token' }))
    expect(screen.getByLabelText('Expires')).toHaveValue('90')
    await user.type(screen.getByLabelText('Name'), 'GitHub Actions')
    await user.click(checkbox('Incidents write'))
    await user.click(checkbox('Reports read'))
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/api-tokens', {
      name: 'GitHub Actions',
      scopes: expect.arrayContaining(['incidents:read', 'incidents:write', 'reports:read']),
      expiresInDays: 90,
    }))
    expect(vi.mocked(api.post).mock.calls[0]![1]).toMatchObject({ scopes: expect.not.arrayContaining(['monitors:read']) })
    expect(await screen.findByText('bsp_full-secret-value')).toBeInTheDocument()
    expect(screen.getByText(/will not be shown again/)).toBeInTheDocument()
  })

  it('opens the form in a dialog, which Cancel closes', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'New token' }))
    const dialog = screen.getByRole('dialog', { name: 'New token' })
    expect(within(dialog).getByLabelText('Name')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'New token' })).not.toBeInTheDocument()
  })

  it('needs at least one permission, and a name', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'New token' }))
    await user.type(screen.getByLabelText('Name'), 'Terraform')
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    await user.click(checkbox('Monitors read'))
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled()
  })

  it('treats writing as including reading', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'New token' }))

    await user.click(checkbox('Monitors write'))
    expect(checkbox('Monitors read')).toBeChecked()
    await user.click(checkbox('Monitors read'))
    expect(checkbox('Monitors write')).not.toBeChecked()
    expect(screen.queryByRole('checkbox', { name: 'Audit log write' })).not.toBeInTheDocument()
  })

  it('fills the permissions from a preset', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'New token' }))

    await user.click(screen.getByRole('button', { name: 'Report incidents' }))
    expect(checkbox('Incidents write')).toBeChecked()
    expect(checkbox('Monitors read')).toBeChecked()
    expect(checkbox('Monitors write')).not.toBeChecked()

    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(checkbox('Incidents write')).not.toBeChecked()
  })

  it('sends vault use only when it is ticked, and never expires only when asked for', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({ ...token, token: 'bsp_x' })
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'New token' }))
    await user.type(screen.getByLabelText('Name'), 'Terraform')
    await user.click(screen.getByRole('button', { name: 'Deploy monitoring' }))
    await user.click(screen.getByRole('checkbox', { name: /Use vault secrets/ }))
    await user.selectOptions(screen.getByLabelText('Expires'), 'never')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/api-tokens', {
      name: 'Terraform',
      scopes: expect.arrayContaining(['monitors:write', 'channels:write', 'vault:use']),
      expiresInDays: null,
    }))
  })

  it('asks before revoking', async () => {
    const user = userEvent.setup()
    vi.mocked(api.delete).mockResolvedValueOnce(undefined)
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Revoke Deploy' }))
    expect(api.delete).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Revoke' }))

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/api-tokens/7'))
  })
})
