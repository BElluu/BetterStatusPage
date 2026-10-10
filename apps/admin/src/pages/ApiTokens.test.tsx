import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import ApiTokensPage from './ApiTokens'

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

const token = { id: 7, name: 'Deploy', prefix: 'bsp_Ab12Cd', role: 'operator', createdBy: 'admin@example.test', createdAt: 1, expiresAt: null, lastUsedAt: null }

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><ApiTokensPage /></QueryClientProvider>)
}

describe('ApiTokensPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue([token])
  })

  it('lists tokens by prefix, never the secret', async () => {
    renderPage()
    expect(await screen.findByText('Deploy')).toBeInTheDocument()
    expect(screen.getByText('bsp_Ab12Cd…')).toBeInTheDocument()
    expect(screen.getByText('Operator')).toBeInTheDocument()
    expect(screen.getByText('admin@example.test')).toBeInTheDocument()
  })

  it('creates a token and shows the secret once', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({ ...token, id: 8, name: 'GitHub Actions', token: 'bsp_full-secret-value' })
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New token' }))
    await user.type(screen.getByLabelText('Name'), 'GitHub Actions')
    await user.selectOptions(screen.getByLabelText('Role'), 'admin')
    await user.selectOptions(screen.getByLabelText('Expires'), '90')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/api-tokens', { name: 'GitHub Actions', role: 'admin', expiresInDays: 90 }))
    expect(await screen.findByText('bsp_full-secret-value')).toBeInTheDocument()
    expect(screen.getByText(/will not be shown again/)).toBeInTheDocument()
  })

  it('omits the expiry when the token never expires and blocks an empty name', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({ ...token, token: 'bsp_x' })
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New token' }))
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    await user.type(screen.getByLabelText('Name'), 'Terraform')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/api-tokens', { name: 'Terraform', role: 'operator' }))
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
