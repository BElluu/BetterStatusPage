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

  it('makes the page private and closes, keeping who gets a viewer account as it is', async () => {
    const user = userEvent.setup()
    vi.mocked(api.get).mockResolvedValue({ ...PUBLIC, ssoCreateViewers: true, ssoViewerDomains: ['example.com'] })
    vi.mocked(api.put).mockImplementation(async (_path, body) => ({ ...(body as AdminStatusPageAccess), ssoConfigured: true }))
    const onClose = renderModal()

    expect(await screen.findByRole('heading', { name: 'Status page access' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: /viewer accounts/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('switch', { name: 'Private status page' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/status-page-access', {
      private: true, ssoCreateViewers: true, ssoViewerDomains: ['example.com'],
    }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('shows why the settings were refused and stays open', async () => {
    const user = userEvent.setup()
    vi.mocked(api.put).mockRejectedValue(new Error('Refused'))
    const onClose = renderModal()

    await user.click(await screen.findByRole('switch', { name: 'Private status page' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Refused')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
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
