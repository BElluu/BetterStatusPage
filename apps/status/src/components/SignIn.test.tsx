import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Branding } from '@bsp/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, getJSON, postJSON } from '../api'
import { SignIn } from './SignIn'

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  getJSON: vi.fn(),
  postJSON: vi.fn(),
}))
vi.mock('../hooks/useDarkMode', () => ({ useDarkMode: () => [false, vi.fn()] as const }))
vi.mock('./LanguageSwitcher', () => ({ LanguageSwitcher: () => null }))
vi.mock('../i18n/LocaleContext', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}))

const authConfig = { value: { passwordLogin: true, oidc: null as null | { label: string; loginUrl?: string } } }

function renderSignIn(branding: Partial<Branding> | null = { siteName: 'Acme Status', enabled: 0 }) {
  const onSignedIn = vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><SignIn branding={branding as Branding | null} onSignedIn={onSignedIn} /></QueryClientProvider>)
  return onSignedIn
}

async function enterPassword() {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('signIn.email'), 'viewer@example.test')
  await user.type(screen.getByLabelText('signIn.password'), 'secret-password')
  await user.click(screen.getByRole('button', { name: 'signIn.submit' }))
  return user
}

describe('SignIn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authConfig.value = { passwordLogin: true, oidc: null }
    vi.mocked(getJSON).mockImplementation(async () => authConfig.value)
    window.history.replaceState(null, '', '/')
  })

  it('signs in with a password in the page branding', async () => {
    vi.mocked(postJSON).mockResolvedValue({ mustChangePassword: false })
    const onSignedIn = renderSignIn()

    expect(screen.getByRole('heading', { name: 'signIn.title' })).toBeInTheDocument()
    expect(screen.getByAltText('Acme Status')).toBeInTheDocument()
    expect(document.title).toBe('Acme Status')
    await enterPassword()

    expect(postJSON).toHaveBeenCalledWith('/api/v1/auth/login', { email: 'viewer@example.test', password: 'secret-password' })
    expect(onSignedIn).toHaveBeenCalled()
  })

  it('shows the password on request and points visitors without access to their administrator', async () => {
    const user = userEvent.setup()
    renderSignIn()

    const password = screen.getByLabelText('signIn.password')
    expect(password).toHaveAttribute('type', 'password')
    await user.click(screen.getByRole('button', { name: 'signIn.showPassword' }))
    expect(password).toHaveAttribute('type', 'text')
    await user.click(screen.getByRole('button', { name: 'signIn.hidePassword' }))
    expect(password).toHaveAttribute('type', 'password')
    expect(screen.getByText('signIn.noAccess')).toBeInTheDocument()
    expect(screen.getByText('signIn.privateBadge')).toBeInTheDocument()
  })

  it('asks for the second factor and verifies it with the challenge', async () => {
    vi.mocked(postJSON)
      .mockResolvedValueOnce({ requiresTwoFactor: true, challengeToken: 'challenge' })
      .mockResolvedValueOnce({ mustChangePassword: false })
    const onSignedIn = renderSignIn()

    const user = await enterPassword()
    await user.type(await screen.findByLabelText('signIn.code'), '123456')
    await user.click(screen.getByRole('button', { name: 'signIn.verify' }))

    expect(postJSON).toHaveBeenLastCalledWith('/api/v1/auth/2fa/verify', { challengeToken: 'challenge', code: '123456' })
    expect(onSignedIn).toHaveBeenCalled()
  })

  it('reports wrong credentials and other failures differently', async () => {
    vi.mocked(postJSON).mockRejectedValueOnce(new ApiError('Invalid credentials', 401))
    renderSignIn()
    await enterPassword()
    expect(await screen.findByRole('alert')).toHaveTextContent('signIn.invalid')

    vi.mocked(postJSON).mockRejectedValueOnce(new ApiError('Too many requests', 429))
    await userEvent.click(screen.getByRole('button', { name: 'signIn.submit' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('signIn.error')
  })

  it('has a user with a temporary password replace it right here before the page opens', async () => {
    vi.mocked(postJSON).mockResolvedValueOnce({ mustChangePassword: true }).mockResolvedValueOnce({ mustChangePassword: false })
    const onSignedIn = renderSignIn()

    const user = await enterPassword()
    expect(await screen.findByRole('heading', { name: 'signIn.setPasswordTitle' })).toBeInTheDocument()
    expect(screen.queryByText('signIn.noAccess')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('signIn.newPassword'), 'short')
    await user.type(screen.getByLabelText('signIn.confirmPassword'), 'short')
    await user.click(screen.getByRole('button', { name: 'signIn.setPasswordSubmit' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('signIn.passwordTooShort')

    await user.clear(screen.getByLabelText('signIn.newPassword'))
    await user.type(screen.getByLabelText('signIn.newPassword'), 'my-own-password')
    await user.click(screen.getByRole('button', { name: 'signIn.setPasswordSubmit' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('signIn.passwordMismatch')

    await user.clear(screen.getByLabelText('signIn.confirmPassword'))
    await user.type(screen.getByLabelText('signIn.confirmPassword'), 'my-own-password')
    await user.click(screen.getByRole('button', { name: 'signIn.setPasswordSubmit' }))

    expect(postJSON).toHaveBeenLastCalledWith('/api/v1/auth/change-password', { newPassword: 'my-own-password' })
    expect(onSignedIn).toHaveBeenCalled()
  })

  it('starts at setting the password for a session that still has a temporary one', async () => {
    const onSignedIn = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><SignIn branding={null} passwordChangeRequired onSignedIn={onSignedIn} /></QueryClientProvider>)

    expect(screen.getByRole('heading', { name: 'signIn.setPasswordTitle' })).toBeInTheDocument()
    expect(screen.queryByLabelText('signIn.email')).not.toBeInTheDocument()
  })

  it('offers SSO that returns to the status page, and only SSO when passwords are off', async () => {
    authConfig.value = { passwordLogin: false, oidc: { label: 'Sign in with SSO', loginUrl: 'https://status.example.test/api/v1/auth/oidc/login' } }
    renderSignIn({ siteName: 'Acme', enabled: 1, logoType: 'text', logoText: 'ACME' } as Partial<Branding>)

    expect(await screen.findByRole('link', { name: 'Sign in with SSO' })).toHaveAttribute('href', 'https://status.example.test/api/v1/auth/oidc/login?returnTo=status')
    expect(screen.getByText('ACME')).toBeInTheDocument()
    expect(screen.queryByLabelText('signIn.password')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'signIn.submit' })).not.toBeInTheDocument()
  })

  it('takes the second factor or the error an SSO sign-in came back with, and cleans the URL', async () => {
    window.history.replaceState(null, '', '/?two-factor=sso&lang=pl')
    vi.mocked(postJSON).mockResolvedValue({ mustChangePassword: false })
    const onSignedIn = renderSignIn()

    expect(window.location.search).toBe('?lang=pl')
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('signIn.code'), '654321')
    await user.click(screen.getByRole('button', { name: 'signIn.verify' }))
    expect(postJSON).toHaveBeenCalledWith('/api/v1/auth/2fa/verify', { code: '654321' })
    expect(onSignedIn).toHaveBeenCalled()
  })

  it('shows why SSO refused the sign-in and goes back from the code step', async () => {
    window.history.replaceState(null, '', '/?sign-in-error=oidc_no_account')
    renderSignIn(null)
    expect(screen.getByRole('alert')).toHaveTextContent('signIn.ssoNoAccount')
    expect(window.location.search).toBe('')
    expect(screen.getByAltText('page.defaultTitle')).toHaveAttribute('src', '/logo_light.png')

    vi.mocked(postJSON).mockResolvedValueOnce({ requiresTwoFactor: true, challengeToken: 'c' })
    const user = await enterPassword()
    await user.click(await screen.findByRole('button', { name: 'signIn.back' }))
    expect(screen.getByLabelText('signIn.password')).toBeInTheDocument()
  })
})
