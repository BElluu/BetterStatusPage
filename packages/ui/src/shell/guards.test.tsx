import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, clearSession, getCurrentUser, mustChangePassword, setSession } from '../api/client'
import { configureUi } from '../config'
import { navigation } from '../navigation'
import { RequireAuth, RequirePasswordChanged, SetupGate, createRoleGuard } from './guards'

vi.mock('../api/client', () => ({
  api: { get: vi.fn() },
  clearSession: vi.fn(),
  getCurrentUser: vi.fn(),
  mustChangePassword: vi.fn(),
  setSession: vi.fn(),
}))

const user = { userId: 1, email: 'a@example.test', role: 'member', mustChangePassword: false, twoFactorEnabled: false }

beforeEach(() => {
  configureUi({ basePath: '/app', apiBase: '/api', redirectAfterSignIn: (signedIn) => signedIn.role === 'guest' ? 'https://public.test/' : null })
})
afterEach(() => vi.restoreAllMocks())

function inRoutes(element: React.ReactNode, at = '/app/page') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/app/page" element={element} />
        <Route path="/app/setup" element={<p>Setup page</p>} />
        <Route path="/app/login" element={<p>Login page</p>} />
        <Route path="/app/change-password" element={<p>Change password page</p>} />
        <Route path="/app/home" element={<p>Home page</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('SetupGate', () => {
  it('sends a first visit to setup, and lets everyone else through', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ needsSetup: true }))))
    inRoutes(<SetupGate><p>Content</p></SetupGate>)
    expect(await screen.findByText('Setup page')).toBeInTheDocument()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ needsSetup: false }))))
    inRoutes(<SetupGate><p>Content</p></SetupGate>)
    expect(await screen.findByText('Content')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/setup/status')
  })

  it('shows the page when the status cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    inRoutes(<SetupGate><p>Content</p></SetupGate>)
    expect(await screen.findByText('Content')).toBeInTheDocument()
  })
})

describe('RequireAuth', () => {
  it('renders the page for a signed-in user and remembers them', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(user)
    inRoutes(<RequireAuth><p>Secret</p></RequireAuth>)
    expect(await screen.findByText('Secret')).toBeInTheDocument()
    expect(setSession).toHaveBeenCalledWith(user)
    expect(api.get).toHaveBeenCalledWith('/auth/session')
  })

  it('sends someone who is not signed in to the sign-in page, forgetting any old session', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('401'))
    inRoutes(<RequireAuth><p>Secret</p></RequireAuth>)
    expect(await screen.findByText('Login page')).toBeInTheDocument()
    expect(clearSession).toHaveBeenCalled()
  })

  it('sends a user the application redirects away to that address, and shows nothing meanwhile', async () => {
    const assign = vi.spyOn(navigation, 'assign').mockImplementation(() => {})
    vi.mocked(api.get).mockResolvedValueOnce({ ...user, role: 'guest' })
    inRoutes(<RequireAuth><p>Secret</p></RequireAuth>)
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://public.test/'))
    expect(screen.queryByText('Secret')).not.toBeInTheDocument()
  })
})

describe('RequirePasswordChanged', () => {
  it('keeps a user with a temporary password on the page where they replace it', () => {
    vi.mocked(mustChangePassword).mockReturnValue(true)
    inRoutes(<RequirePasswordChanged><p>Content</p></RequirePasswordChanged>)
    expect(screen.getByText('Change password page')).toBeInTheDocument()
    vi.mocked(mustChangePassword).mockReturnValue(false)
    inRoutes(<RequirePasswordChanged><p>Content</p></RequirePasswordChanged>)
    expect(screen.getByText('Content')).toBeInTheDocument()
  })
})

describe('createRoleGuard', () => {
  const RequireRole = createRoleGuard({ roleRank: { owner: 3, member: 2 }, homeOf: (role) => role === 'member' ? '/app/home' : '/app/login' })

  it('lets a role through whose rank reaches the page, and sends the others home', () => {
    vi.mocked(getCurrentUser).mockReturnValue({ ...user, role: 'owner' })
    inRoutes(<RequireRole minRole="member"><p>Content</p></RequireRole>)
    expect(screen.getByText('Content')).toBeInTheDocument()

    vi.mocked(getCurrentUser).mockReturnValue({ ...user, role: 'member' })
    inRoutes(<RequireRole minRole="owner"><p>Content</p></RequireRole>)
    expect(screen.getByText('Home page')).toBeInTheDocument()
  })

  it('treats a role it does not know as the lowest, and a page that asks for an unknown role as closed', () => {
    vi.mocked(getCurrentUser).mockReturnValue({ ...user, role: 'stranger' })
    inRoutes(<RequireRole minRole="member"><p>Content</p></RequireRole>)
    expect(screen.getByText('Login page')).toBeInTheDocument()
    vi.mocked(getCurrentUser).mockReturnValue({ ...user, role: 'owner' })
    inRoutes(<RequireRole minRole="nobody"><p>Content</p></RequireRole>)
    expect(screen.getAllByText('Login page').length).toBeGreaterThan(0)
  })
})
