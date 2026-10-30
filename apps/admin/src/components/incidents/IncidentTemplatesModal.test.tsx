import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '@better-forge/ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import { IncidentTemplatesModal } from './IncidentTemplatesModal'

vi.mock('../../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

const templates = [
  { id: 1, name: 'Standard', title: '{{monitor}} down', body: 'b', resolvedBody: 'r', impact: 'major', isDefault: true, translations: {} },
  { id: 2, name: 'Database', title: 'DB down', body: 'b2', resolvedBody: 'r2', impact: 'critical', isDefault: false, translations: {} },
]
const locales = [{ code: 'en', name: 'English', isDefault: 1 }, { code: 'pl', name: 'Polski', isDefault: 0 }]

function renderModal() {
  const onClose = vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><ToastProvider><IncidentTemplatesModal onClose={onClose} /></ToastProvider></QueryClientProvider>)
  return { onClose }
}

beforeEach(() => {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/incident-templates') return templates
    if (path === '/admin/locales') return locales
    throw new Error(`Unexpected GET ${path}`)
  })
  vi.mocked(api.post).mockResolvedValue({})
  vi.mocked(api.patch).mockResolvedValue({})
  vi.mocked(api.delete).mockResolvedValue(undefined)
})

describe('IncidentTemplatesModal', () => {
  it('lists templates and offers delete only for non-default ones', async () => {
    const { onClose } = renderModal()
    await screen.findByText('Database')
    expect(screen.getByText('default')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete Standard' })).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(onClose).toHaveBeenCalled()
  })

  it('deletes a template', async () => {
    renderModal()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Delete Database' }))
    expect(api.delete).toHaveBeenCalledWith('/admin/incident-templates/2')
    expect(await screen.findByText('Template deleted')).toBeInTheDocument()
  })

  it('reports a failed delete', async () => {
    vi.mocked(api.delete).mockRejectedValue(new Error('in use'))
    renderModal()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Delete Database' }))
    expect(await screen.findByText("Couldn't delete template: in use")).toBeInTheDocument()
  })

  it('creates a template with a translation', async () => {
    const user = userEvent.setup()
    renderModal()
    await screen.findByText('Database')
    await user.click(screen.getByRole('button', { name: /New template/ }))
    await screen.findByText('Polski')
    // name, incident title, opening, resolved, then the translated title
    const inputs = screen.getAllByRole('textbox')
    await user.type(inputs[0]!, 'Network')
    await user.selectOptions(screen.getByRole('combobox'), 'minor')
    await user.type(inputs[4]!, 'Awaria')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.post).toHaveBeenCalledWith('/admin/incident-templates', expect.objectContaining({
      name: 'Network', impact: 'minor', translations: { pl: { title: 'Awaria' } },
    }))
    expect(await screen.findByText('Template saved')).toBeInTheDocument()
  })

  it('edits an existing template and shows a save error', async () => {
    vi.mocked(api.patch).mockRejectedValue(new Error('Name taken'))
    const user = userEvent.setup()
    renderModal()
    await user.click(await screen.findByRole('button', { name: 'Edit Database' }))
    expect(screen.getByDisplayValue('DB down')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.patch).toHaveBeenCalledWith('/admin/incident-templates/2', expect.objectContaining({ name: 'Database' }))
    expect(await screen.findByText('Name taken')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText('Incident templates')).toBeInTheDocument()
  })
})
