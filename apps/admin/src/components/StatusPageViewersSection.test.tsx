import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AdminStatusPageAccess } from '@bsp/shared'
import type { SsoSectionSave } from '@better-forge/ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { StatusPageViewersSection } from './StatusPageViewersSection'

vi.mock('../api/client', () => ({ api: { get: vi.fn(), put: vi.fn() } }))

const PUBLIC: AdminStatusPageAccess = { private: false, ssoCreateViewers: false, ssoViewerDomains: [], ssoConfigured: true }

function renderSection() {
  const reported: { save: SsoSectionSave | null; badge: string | null | undefined } = { save: null, badge: undefined }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><StatusPageViewersSection onChange={(save, badge) => { reported.save = save; reported.badge = badge }} /></QueryClientProvider>)
  return reported
}

describe('StatusPageViewersSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue({ ...PUBLIC, private: true })
    vi.mocked(api.put).mockImplementation(async (_path, body) => ({ ...(body as object), ssoConfigured: true }))
  })

  it('reports nothing to save until something changes', async () => {
    const reported = renderSection()
    await screen.findByRole('switch', { name: 'Create viewer accounts on sign-in' })
    expect(reported.save).toBeNull()
  })

  it('saves the domains and leaves the page as private as it is', async () => {
    const user = userEvent.setup()
    const reported = renderSection()

    await user.click(await screen.findByRole('switch', { name: 'Create viewer accounts on sign-in' }))
    await user.type(screen.getByLabelText('Email domains'), 'Example.com, example.org')
    expect(reported.badge).toBe('2')
    await reported.save!.save(undefined)

    expect(api.put).toHaveBeenCalledTimes(1)
    expect(api.put).toHaveBeenCalledWith('/admin/status-page-access', { private: true, ssoCreateViewers: true, ssoViewerDomains: ['example.com', 'example.org'] })
  })

  it('says that it applies once the page is private, when it is public now', async () => {
    vi.mocked(api.get).mockResolvedValue(PUBLIC)
    renderSection()
    expect(await screen.findByText(/The status page is public now/)).toBeInTheDocument()
  })

  it('reports why it cannot be saved before anything is sent', async () => {
    const user = userEvent.setup()
    const reported = renderSection()

    await user.click(await screen.findByRole('switch', { name: 'Create viewer accounts on sign-in' }))
    await waitFor(() => expect(reported.save?.problem).toBe('Add at least one email domain to create viewer accounts on SSO sign-in'))
    expect(api.put).not.toHaveBeenCalled()
  })
})
