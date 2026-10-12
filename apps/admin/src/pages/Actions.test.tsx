import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Action } from '@bsp/shared'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import ActionsPage from './Actions'

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

const actions = [
  { id: 1, name: 'Start VM2', enabled: 1, config: { url: 'https://jenkins.test/job/vm2/build', method: 'POST', headers: { Authorization: '••••••••' } } },
  { id: 2, name: 'Stop VM2', enabled: 0, config: { url: 'https://jenkins.test/job/stop-vm2/build', method: 'POST' } },
] as unknown as Action[]

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter><ActionsPage /></MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/actions') return actions
    throw new Error(`Unexpected GET ${path}`)
  })
})

describe('Actions page', () => {
  it('lists actions with their request and state, and links to the run history', async () => {
    renderPage()

    const row = (await screen.findByRole('button', { name: 'Edit Start VM2' })).closest('tr')!
    expect(within(row).getByText('POST https://jenkins.test/job/vm2/build')).toBeInTheDocument()
    expect(within(row).getByText('Active')).toBeInTheDocument()
    expect(within(screen.getByRole('button', { name: 'Edit Stop VM2' }).closest('tr')!).getByText('Disabled')).toBeInTheDocument()

    expect(screen.getByRole('link', { name: /Run history/ })).toHaveAttribute('href', '/admin/delivery-history?tab=actions')
  })

  it('creates an action through the form', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValue({})
    renderPage()
    await screen.findByRole('button', { name: 'Edit Start VM2' })

    await user.click(screen.getByRole('button', { name: /Add Action/ }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByPlaceholderText('Start VM2'), 'Wake VM3')
    await user.type(within(dialog).getByPlaceholderText('https://example.com/alert'), 'https://jenkins.test/job/vm3/build')
    await user.click(within(dialog).getByRole('button', { name: 'Create Action' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/actions', expect.objectContaining({
      name: 'Wake VM3', enabled: 1, config: expect.objectContaining({ url: 'https://jenkins.test/job/vm3/build', method: 'POST' }),
    })))
  })

  it('deletes an action after confirmation', async () => {
    const user = userEvent.setup()
    vi.mocked(api.delete).mockResolvedValue(undefined)
    renderPage()
    await screen.findByRole('button', { name: 'Edit Start VM2' })

    await user.click(screen.getByRole('button', { name: 'Delete Start VM2' }))
    await user.click(await screen.findByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/actions/1'))
  })
})
