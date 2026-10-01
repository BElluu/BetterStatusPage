import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AdminStatusPageAccess } from '@bsp/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { StatusPageAccessModal } from './StatusPageAccessModal'

vi.mock('../api/client', () => ({ api: { get: vi.fn(), put: vi.fn() } }))

const PUBLIC: AdminStatusPageAccess = { private: false, ssoCreateViewers: false, ssoViewerDomains: [], ssoConfigured: true }

function renderModal() {
  const onClose = vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><StatusPageAccessModal onClose={onClose} /></QueryClientProvider>)
  return onClose
}

describe('StatusPageAccessModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue(PUBLIC)
  })

  it('makes the page private, lets SSO create viewer accounts for listed domains and closes', async () => {
    const user = userEvent.setup()
    vi.mocked(api.put).mockImplementation(async (_path, body) => ({ ...(body as AdminStatusPageAccess), ssoConfigured: true }))
    const onClose = renderModal()

    expect(await screen.findByRole('heading', { name: 'Status page access' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Create viewer accounts on single sign-on' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('switch', { name: 'Private status page' }))
    await user.click(screen.getByRole('switch', { name: 'Create viewer accounts on single sign-on' }))
    await user.type(screen.getByLabelText('Email domains'), 'example.com, example.org;  ')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/status-page-access', {
      private: true, ssoCreateViewers: true, ssoViewerDomains: ['example.com', 'example.org'],
    }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('shows why the settings were refused and stays open', async () => {
    const user = userEvent.setup()
    vi.mocked(api.put).mockRejectedValue(new Error('Add at least one email domain to create viewer accounts on SSO sign-in'))
    vi.mocked(api.get).mockResolvedValue({ ...PUBLIC, private: true })
    const onClose = renderModal()

    await user.click(await screen.findByRole('switch', { name: 'Create viewer accounts on single sign-on' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/Add at least one email domain/)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('needs single sign-on before it can create viewer accounts', async () => {
    vi.mocked(api.get).mockResolvedValue({ ...PUBLIC, private: true, ssoConfigured: false })
    renderModal()

    expect(await screen.findByRole('switch', { name: 'Create viewer accounts on single sign-on' })).toBeDisabled()
    expect(screen.getByText('Set up single sign-on first.')).toBeInTheDocument()
  })

  it('offers a retry when the settings cannot be loaded', async () => {
    const user = userEvent.setup()
    vi.mocked(api.get).mockRejectedValueOnce(new Error('offline'))
    const onClose = renderModal()

    await user.click(await screen.findByRole('button', { name: /Try again/ }))
    expect(await screen.findByRole('switch', { name: 'Private status page' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })
})
