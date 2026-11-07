import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AdminSsoProvisioning } from '@bsp/shared'
import type { SsoSectionSave } from '@better-forge/ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { AdminSignInSection } from './AdminSignInSection'

vi.mock('../api/client', () => ({ api: { get: vi.fn(), put: vi.fn() } }))

const OFF: AdminSsoProvisioning = { enabled: false, allowedDomains: [], groupsClaim: 'groups', groupRoles: [], ssoConfigured: true }

/** The section as the Single sign-on dialog holds it: what it last reported is what Save runs. */
function renderSection() {
  const reported: { save: SsoSectionSave | null; badge: string | null | undefined } = { save: null, badge: undefined }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><AdminSignInSection onChange={(save, badge) => { reported.save = save; reported.badge = badge }} /></QueryClientProvider>)
  return reported
}

describe('AdminSignInSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue(OFF)
    vi.mocked(api.put).mockImplementation(async (_path, body) => ({ ...(body as object), ssoConfigured: true }))
  })

  it('reports nothing to save until something changes', async () => {
    const reported = renderSection()
    await screen.findByRole('switch', { name: 'Create accounts on sign-in' })
    expect(reported.save).toBeNull()
  })

  it('saves the domains and the group mapping with the password, and shows the number of groups on its icon', async () => {
    const user = userEvent.setup()
    const reported = renderSection()

    await user.click(await screen.findByRole('switch', { name: 'Create accounts on sign-in' }))
    await user.type(screen.getByLabelText('Email domains'), 'Corp.test, other.test')
    await user.type(screen.getByLabelText('Group 1'), 'Technicians')
    await user.selectOptions(screen.getByLabelText('Role of group 1'), 'admin')
    expect(screen.getByText(/A group is mapped to Admin/)).toBeInTheDocument()

    expect(reported.save?.problem).toBeUndefined()
    expect(reported.badge).toBe('1')
    await reported.save!.save('secret-password')
    expect(api.put).toHaveBeenCalledWith('/admin/sso-provisioning', {
      enabled: true, allowedDomains: ['corp.test', 'other.test'], groupsClaim: 'groups',
      groupRoles: [{ group: 'Technicians', role: 'admin' }], currentPassword: 'secret-password',
    })
  })

  it('sends no password when there is none, as in an SSO session', async () => {
    const user = userEvent.setup()
    const reported = renderSection()

    await user.click(await screen.findByRole('switch', { name: 'Create accounts on sign-in' }))
    await user.type(screen.getByLabelText('Email domains'), 'corp.test')
    await user.type(screen.getByLabelText('Group 1'), 'Technicians')
    await reported.save!.save(undefined)

    expect(vi.mocked(api.put).mock.calls[0]![1]).not.toHaveProperty('currentPassword')
  })

  it('reports why it cannot be saved before anything is sent', async () => {
    const user = userEvent.setup()
    const reported = renderSection()

    await user.click(await screen.findByRole('switch', { name: 'Create accounts on sign-in' }))
    await waitFor(() => expect(reported.save?.problem).toBe('Add at least one email domain to create accounts on SSO sign-in'))
    await user.type(screen.getByLabelText('Email domains'), 'corp.test')
    await waitFor(() => expect(reported.save?.problem).toBe('Map at least one group to a role to create accounts on SSO sign-in'))
    expect(api.put).not.toHaveBeenCalled()
  })
})
