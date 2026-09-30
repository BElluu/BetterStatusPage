import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, getCurrentUser } from '../api/client'
import UsersPage from './Users'

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  getCurrentUser: vi.fn(),
}))

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><UsersPage /></QueryClientProvider>)
}

describe('UsersPage 2FA recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCurrentUser).mockReturnValue({ userId: 1, email: 'admin@example.test', role: 'admin', mustChangePassword: false, twoFactorEnabled: true })
    vi.mocked(api.get).mockResolvedValue([
      { id: 1, email: 'admin@example.test', role: 'admin', pendingTemporaryPassword: false, ssoLinked: false, twoFactorEnabled: 1, createdAt: 1 },
      { id: 2, email: 'operator@example.test', role: 'operator', pendingTemporaryPassword: false, ssoLinked: false, twoFactorEnabled: 1, createdAt: 1 },
    ])
  })

  it('resets another user 2FA after explicit confirmation', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({ twoFactorEnabled: false })
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Reset 2FA for operator@example.test' }))
    expect(screen.queryByRole('button', { name: 'Reset 2FA for admin@example.test' })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Your current password'), 'admin-password')
    await user.type(screen.getByLabelText(/Type operator@example.test to confirm/), 'operator@example.test')
    await user.click(screen.getByRole('button', { name: 'Reset 2FA' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/users/2/reset-2fa', { currentPassword: 'admin-password' }))
    expect(await screen.findByText('Two-factor authentication reset for operator@example.test.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('UsersPage confirmations and feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCurrentUser).mockReturnValue({ userId: 1, email: 'admin@example.test', role: 'admin', mustChangePassword: false, twoFactorEnabled: false })
    vi.mocked(api.get).mockResolvedValue([
      { id: 1, email: 'admin@example.test', role: 'admin', pendingTemporaryPassword: false, ssoLinked: false, twoFactorEnabled: 0, createdAt: 1 },
      { id: 2, email: 'operator@example.test', role: 'operator', pendingTemporaryPassword: true, ssoLinked: false, twoFactorEnabled: 0, createdAt: 1 },
    ])
  })

  it('asks before resetting a password and shows the new temporary password', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({ temporaryPassword: 'tmp-123' })
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Reset password for operator@example.test' }))
    expect(screen.getByText('Reset password for operator@example.test? Their current password will stop working.')).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Reset password' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/users/2/reset-password', {}))
    expect(await screen.findByText('tmp-123')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('confirms a demotion but promotes immediately', async () => {
    const user = userEvent.setup()
    vi.mocked(api.patch).mockResolvedValue({})
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Admin' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/users/2/role', { role: 'admin' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    vi.mocked(api.patch).mockClear()
    await user.click(screen.getByRole('button', { name: 'Branding' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('from Operator to Branding')
    expect(api.patch).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Make Branding' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/users/2/role', { role: 'branding' }))
  })

  it('shows loading and error states with retry', async () => {
    const user = userEvent.setup()
    vi.mocked(api.get).mockRejectedValueOnce(new Error('down'))
    renderPage()
    expect(screen.getByText('Loading users…')).toBeInTheDocument()
    expect(screen.queryByText('No users yet.')).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: /Try again/ }))
    expect(await screen.findByText('operator@example.test')).toBeInTheDocument()
  })
})
