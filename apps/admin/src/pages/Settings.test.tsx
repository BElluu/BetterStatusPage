import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, clearSession, getCurrentUser, setSession, type AuthUser } from '../api/client'
import SettingsPage from './Settings'

vi.mock('../api/client', () => ({
  api: { post: vi.fn() },
  clearSession: vi.fn(),
  getCurrentUser: vi.fn(),
  setSession: vi.fn(),
}))

const currentUser: AuthUser = {
  userId: 1,
  email: 'admin@example.test',
  role: 'admin',
  mustChangePassword: false,
  twoFactorEnabled: false,
}

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/admin/settings']}>
      <Routes>
        <Route path="/admin/settings" element={<SettingsPage />} />
        <Route path="/admin/login" element={<div>Login screen</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

function section(name: string) {
  const heading = screen.getByRole('heading', { name })
  const element = heading.closest('section')
  if (!element) throw new Error(`Section not found: ${name}`)
  return within(element)
}

describe('SettingsPage security flows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCurrentUser).mockReturnValue(currentUser)
  })

  it('changes the password and replaces the local session', async () => {
    const user = userEvent.setup()
    const updated = { ...currentUser, mustChangePassword: false }
    vi.mocked(api.post).mockResolvedValueOnce(updated)
    renderSettings()
    const password = section('Change password')

    await user.type(password.getByLabelText('Current password'), 'old-password')
    await user.type(password.getByLabelText('New password'), 'new-password')
    await user.type(password.getByLabelText('Confirm new password'), 'new-password')
    await user.click(password.getByRole('button', { name: 'Update password' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/change-password', {
      currentPassword: 'old-password',
      newPassword: 'new-password',
    }))
    expect(setSession).toHaveBeenCalledWith(updated)
    expect(screen.getByText('Password changed. Other active sessions were signed out.')).toBeInTheDocument()
  })

  it('shows the QR setup and recovery codes when enabling 2FA', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce({ secret: 'SECRET', uri: 'otpauth://totp/test', qrDataUrl: 'data:image/png;base64,abc', setupToken: 'setup-token' })
      .mockResolvedValueOnce({ recoveryCodes: ['recovery-1', 'recovery-2'] })
    renderSettings()
    let twoFactor = section('Two-factor authentication')

    await user.type(twoFactor.getByLabelText('Current password'), 'password')
    await user.click(twoFactor.getByRole('button', { name: 'Set up 2FA' }))
    expect(await twoFactor.findByRole('img', { name: 'QR code for two-factor authentication setup' })).toHaveAttribute('src', 'data:image/png;base64,abc')
    expect(twoFactor.getByText('Cannot scan the QR code?')).toBeInTheDocument()

    await user.type(twoFactor.getByLabelText('Authentication code'), '123456')
    await user.click(twoFactor.getByRole('button', { name: 'Verify and enable' }))
    twoFactor = section('Two-factor authentication')
    expect(await twoFactor.findByText('recovery-1')).toBeInTheDocument()
    expect(twoFactor.getByText('recovery-2')).toBeInTheDocument()
    await user.click(twoFactor.getByRole('button', { name: /Copy codes/ }))
    expect(twoFactor.getByRole('button', { name: /Copied!/ })).toBeInTheDocument()
    expect(api.post).toHaveBeenNthCalledWith(2, '/auth/2fa/enable', { setupToken: 'setup-token', code: '123456' })
    expect(setSession).toHaveBeenCalledWith({ ...currentUser, twoFactorEnabled: true })
  })

  it('disables 2FA after password and code verification', async () => {
    const user = userEvent.setup()
    vi.mocked(getCurrentUser).mockReturnValue({ ...currentUser, twoFactorEnabled: true })
    vi.mocked(api.post).mockResolvedValueOnce({ twoFactorEnabled: false })
    renderSettings()
    const twoFactor = section('Two-factor authentication')

    await user.type(twoFactor.getByLabelText('Current password'), 'password')
    await user.type(twoFactor.getByLabelText('Authentication or recovery code'), '123456')
    await user.click(twoFactor.getByRole('button', { name: 'Disable 2FA' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/2fa/disable', { currentPassword: 'password', code: '123456' }))
    expect(setSession).toHaveBeenCalledWith({ ...currentUser, twoFactorEnabled: false })
    expect(screen.getByText('Two-factor authentication is disabled.')).toBeInTheDocument()
  })

  it('signs out every session and navigates to login', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce(undefined)
    renderSettings()
    await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/logout-all'))
    expect(clearSession).toHaveBeenCalled()
    expect(screen.getByText('Login screen')).toBeInTheDocument()
  })
})
