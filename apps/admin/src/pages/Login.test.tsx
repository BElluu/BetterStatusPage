import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, setSession, type AuthUser } from '../api/client'
import LoginPage from './Login'

vi.mock('../api/client', () => ({
  api: { post: vi.fn(), get: vi.fn().mockResolvedValue({ passwordLogin: true, oidc: null }) },
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

function renderLogin(entry = '/admin/login') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
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

    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username')
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password')
    expect(screen.queryByText('99.9%')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Email'), 'admin@example.test')
    await user.type(screen.getByLabelText('Password'), 'password')
    const signIn = screen.getByRole('button', { name: 'Sign in' })
    expect(signIn).toHaveClass('btn-primary')
    await user.click(signIn)

    expect(await screen.findByLabelText('Authentication code')).toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Authentication code'), '123456')
    const verify = screen.getByRole('button', { name: 'Verify & sign in' })
    expect(verify).toHaveClass('btn-primary')
    await user.click(verify)

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
    await user.click(await screen.findByRole('button', { name: 'Back to sign-in' }))
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(screen.queryByLabelText('Authentication code')).not.toBeInTheDocument()
  })

  it('asks for the code after an SSO sign-in of a user with 2FA', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce(authenticatedUser)
    renderLogin('/admin/login?two-factor=sso')

    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Authentication code'), '123456')
    await user.click(screen.getByRole('button', { name: 'Verify & sign in' }))

    await waitFor(() => expect(setSession).toHaveBeenCalledWith(authenticatedUser))
    expect(api.post).toHaveBeenCalledWith('/auth/2fa/verify', { code: '123456' })
  })

  it('starts SSO on the host the identity provider returns to', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ passwordLogin: true, oidc: { label: 'Company SSO', loginUrl: 'http://localhost:5173/api/v1/auth/oidc/login' } })
    renderLogin()
    expect(await screen.findByRole('link', { name: 'Company SSO' })).toHaveAttribute('href', 'http://localhost:5173/api/v1/auth/oidc/login')
  })
})
