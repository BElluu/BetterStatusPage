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
      { id: 1, email: 'admin@example.test', role: 'admin', mustChangePassword: 0, twoFactorEnabled: 1, createdAt: 1 },
      { id: 2, email: 'operator@example.test', role: 'operator', mustChangePassword: 0, twoFactorEnabled: 1, createdAt: 1 },
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
