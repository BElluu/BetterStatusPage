import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import SsoTestResultPage from './SsoTestResult'

vi.mock('../api/client', () => ({
  api: { get: vi.fn() },
}))

const base = {
  issuer: 'https://idp.example.test',
  testedAt: Date.UTC(2026, 8, 1, 12),
  claims: null,
  user: null,
  denial: null,
}

function renderPage(url = '/admin/sso-test?result=abc/1') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <SsoTestResultPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('SsoTestResultPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('explains there is nothing to show without a result id and skips the request', () => {
    renderPage('/admin/sso-test')
    expect(screen.getByText(/No test result to show/)).toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalled()
  })

  it('shows a successful sign-in with key claims first and the rest sorted', async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...base,
      outcome: 'sign_in',
      user: 'owner@example.test',
      claims: { zeta: 'z', email: 'owner@example.test', alpha: { nested: true }, sub: 'u-1', email_verified: true },
    })
    renderPage()

    expect(await screen.findByText('owner@example.test', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText(/matched by their linked identity-provider account/)).toBeInTheDocument()
    expect(screen.getByText('https://idp.example.test')).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledWith('/admin/oidc/test-sign-in/abc%2F1')

    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
      .map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent))
    expect(rows).toEqual([
      ['sub', 'u-1'],
      ['email', 'owner@example.test'],
      ['email_verified', 'true'],
      ['alpha', '{"nested":true}'],
      ['zeta', 'z'],
    ])
  })

  it('shows an email match that will link the account', async () => {
    vi.mocked(api.get).mockResolvedValue({ ...base, outcome: 'link', user: 'new@example.test', claims: {} })
    renderPage()

    expect(await screen.findByText(/first real sign-in links/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('shows why sign-in would be refused', async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...base,
      outcome: 'deny',
      denial: { code: 'no_user', reason: 'No user has this email.' },
    })
    renderPage()

    expect(await screen.findByText('Sign-in would be refused (no_user)')).toBeInTheDocument()
    expect(screen.getByText('No user has this email.')).toBeInTheDocument()
  })

  it('shows the request error', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('Test result expired'))
    renderPage()

    expect(await screen.findByText('Test result expired')).toBeInTheDocument()
  })
})
