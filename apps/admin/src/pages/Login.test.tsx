import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, setSession, type AuthUser } from '../api/client'
import LoginPage from './Login'

vi.mock('../api/client', () => ({
  api: { post: vi.fn() },
  setSession: vi.fn(),
}))

vi.mock('../hooks/useDarkMode', () => ({
  useDarkMode: () => [false, vi.fn()] as const,
}))

const authenticatedUser: AuthUser = {
  userId: 1,
  email: 'admin@example.test',
  role: 'admin',
  mustChangePassword: false,
  twoFactorEnabled: true,
}

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/admin/login']}>
      <Routes>
        <Route path="/admin/login" element={<LoginPage />} />
        <Route path="/admin/" element={<div>Admin home</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('LoginPage two-factor flow', () => {
  beforeEach(() => vi.clearAllMocks())

  it('moves from password login to 2FA verification and stores the session', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce({ requiresTwoFactor: true, challengeToken: 'challenge-token' })
      .mockResolvedValueOnce(authenticatedUser)
    renderLogin()

    await user.type(screen.getByLabelText('Email'), 'admin@example.test')
    await user.type(screen.getByLabelText('Password'), 'password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByLabelText('Authentication code')).toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Authentication code'), '123456')
    await user.click(screen.getByRole('button', { name: 'Verify & sign in' }))

    await waitFor(() => expect(setSession).toHaveBeenCalledWith(authenticatedUser))
    expect(screen.getByText('Admin home')).toBeInTheDocument()
    expect(api.post).toHaveBeenNthCalledWith(2, '/auth/2fa/verify', {
      challengeToken: 'challenge-token',
      code: '123456',
    })
  })

  it('allows returning from the 2FA challenge to password sign-in', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({ requiresTwoFactor: true, challengeToken: 'challenge-token' })
    renderLogin()
    await user.type(screen.getByLabelText('Email'), 'admin@example.test')
    await user.type(screen.getByLabelText('Password'), 'password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await user.click(await screen.findByRole('button', { name: 'Back to password sign-in' }))
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(screen.queryByLabelText('Authentication code')).not.toBeInTheDocument()
  })
})
