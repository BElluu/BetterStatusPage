import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, isAuthenticated, setSession, type AuthUser } from '../api/client'
import SetupPage from './Setup'

vi.mock('../api/client', () => ({
  api: { post: vi.fn() },
  isAuthenticated: vi.fn(),
  setSession: vi.fn(),
}))

const { toggleDark } = vi.hoisted(() => ({ toggleDark: vi.fn() }))
vi.mock('../hooks/useDarkMode', () => ({
  useDarkMode: () => [false, toggleDark] as const,
}))

const admin: AuthUser = {
  userId: 1,
  email: 'owner@example.test',
  role: 'admin',
  mustChangePassword: false,
  twoFactorEnabled: false,
}

function mockSetupStatus(needsSetup: boolean) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ needsSetup })))
}

function renderSetup() {
  return render(
    <MemoryRouter initialEntries={['/admin/setup']}>
      <Routes>
        <Route path="/admin/setup" element={<SetupPage />} />
        <Route path="/admin/" element={<div>Admin home</div>} />
        <Route path="/admin/login" element={<div>Login screen</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function goToAccountStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Continue' }))
  expect(screen.getByRole('heading', { name: 'Create admin account' })).toBeInTheDocument()
}

async function fillAccount(user: ReturnType<typeof userEvent.setup>, password: string, confirm = password) {
  await user.type(screen.getByPlaceholderText('admin@example.com'), admin.email)
  await user.type(screen.getByPlaceholderText('Min. 8 characters'), password)
  await user.type(screen.getByPlaceholderText('Repeat password'), confirm)
  await user.click(screen.getByRole('button', { name: 'Create Account' }))
}

describe('SetupPage first-run wizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAuthenticated).mockReturnValue(false)
  })

  it('creates the administrator account and opens the dashboard', async () => {
    const user = userEvent.setup()
    mockSetupStatus(true)
    vi.mocked(api.post).mockResolvedValueOnce(admin)
    renderSetup()

    expect(await screen.findByRole('heading', { name: 'Choose a database' })).toBeInTheDocument()
    // The eyebrow counts the same three steps as the progress list.
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument()
    await goToAccountStep(user)
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username')
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password')
    await fillAccount(user, 'correct-horse')

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/setup/complete', { email: admin.email, password: 'correct-horse' }))
    expect(setSession).toHaveBeenCalledWith(admin)
    expect(await screen.findByRole('heading', { name: "You're all set." })).toBeInTheDocument()
    expect(screen.getAllByText(admin.email).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: 'Go to Dashboard' }))
    expect(await screen.findByText('Admin home')).toBeInTheDocument()
  })

  it('rejects mismatched passwords before calling the API', async () => {
    const user = userEvent.setup()
    mockSetupStatus(true)
    renderSetup()

    await goToAccountStep(user)
    await fillAccount(user, 'correct-horse', 'correct-horsE')

    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('rejects passwords shorter than 8 characters', async () => {
    const user = userEvent.setup()
    mockSetupStatus(true)
    renderSetup()

    await goToAccountStep(user)
    await fillAccount(user, 'short')

    expect(await screen.findByText('Password must be at least 8 characters')).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('shows the server error and clears it when going back', async () => {
    const user = userEvent.setup()
    mockSetupStatus(true)
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Setup already completed'))
    renderSetup()

    await goToAccountStep(user)
    await fillAccount(user, 'correct-horse')
    expect(await screen.findByText('Setup already completed')).toBeInTheDocument()
    expect(setSession).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    await goToAccountStep(user)
    expect(screen.queryByText('Setup already completed')).not.toBeInTheDocument()
  })

  it('redirects to login when the instance is already set up', async () => {
    mockSetupStatus(false)
    renderSetup()

    expect(await screen.findByText('Login screen')).toBeInTheDocument()
  })

  it('redirects a signed-in user to the dashboard when setup is complete', async () => {
    mockSetupStatus(false)
    vi.mocked(isAuthenticated).mockReturnValue(true)
    renderSetup()

    expect(await screen.findByText('Admin home')).toBeInTheDocument()
  })

  it('still shows the wizard when the status check fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    renderSetup()

    expect(await screen.findByRole('heading', { name: 'Choose a database' })).toBeInTheDocument()
  })

  it('toggles dark mode from the wizard', async () => {
    const user = userEvent.setup()
    mockSetupStatus(true)
    renderSetup()

    await user.click(await screen.findByRole('button', { name: 'Toggle dark mode' }))

    expect(toggleDark).toHaveBeenCalledOnce()
  })
})
