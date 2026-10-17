import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, getCurrentUser } from '../api/client'
import UsersPage from './Users'
import { configureForTests } from '../testing/configure'

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  getCurrentUser: vi.fn(),
}))

configureForTests()

const roles = [
  { value: 'admin', label: 'Admin', desc: 'Full access' },
  { value: 'operator', label: 'Operator', desc: 'Everything except Users' },
  { value: 'branding', label: 'Branding', desc: 'Branding' },
  { value: 'viewer', label: 'Viewer', desc: 'Views only' },
]
const roleRank = { admin: 3, operator: 2, branding: 1, viewer: 0 }
const actions = [{ label: 'Access settings', icon: 'lock', dialog: (close: () => void) => (
  <div role="dialog" aria-label="Access"><p>Access settings dialog</p><button type="button" onClick={close}>Close access</button></div>
) }]

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><UsersPage roles={roles} roleRank={roleRank} defaultRole="branding" actions={actions} /></QueryClientProvider>)
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

describe('UsersPage roles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCurrentUser).mockReturnValue({ userId: 1, email: 'admin@example.test', role: 'admin', mustChangePassword: false, twoFactorEnabled: false })
    vi.mocked(api.get).mockResolvedValue([
      { id: 1, email: 'admin@example.test', role: 'admin', pendingTemporaryPassword: false, ssoLinked: false, twoFactorEnabled: 0, createdAt: 1 },
      { id: 3, email: 'viewer@example.test', role: 'viewer', pendingTemporaryPassword: false, ssoLinked: true, twoFactorEnabled: 0, createdAt: 1 },
    ])
  })

  it('creates a user with the chosen role', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({ email: 'reader@example.test', temporaryPassword: 'tmp-456' })
    renderPage()

    await user.click(await screen.findByRole('button', { name: /New User/ }))
    await user.type(screen.getByLabelText('Email'), 'reader@example.test')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'viewer')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/users', { email: 'reader@example.test', role: 'viewer' }))
    expect(await screen.findByText('tmp-456')).toBeInTheDocument()
  })

  it('opens the dialogs the application adds next to single sign-on, and closes them', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: /Access settings/ }))
    expect(screen.getByText('Access settings dialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close access' }))
    expect(screen.queryByText('Access settings dialog')).not.toBeInTheDocument()
  })

  it('shows viewers with the Viewer role selected', async () => {
    renderPage()
    const group = await screen.findByRole('group', { name: 'Role for viewer@example.test' })
    expect(group.querySelector('[aria-pressed="true"]')).toHaveTextContent('Viewer')
  })
})
