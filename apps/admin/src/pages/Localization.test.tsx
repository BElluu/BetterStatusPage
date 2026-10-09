import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EN_DEFAULTS } from '@bsp/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import LocalizationPage from './Localization'

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

const locales = [
  { code: 'en', name: 'English', isDefault: 1, translations: {} },
  { code: 'pl', name: 'Polski', isDefault: 0, translations: { 'status.operational': 'Działa' } },
]

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><LocalizationPage /></QueryClientProvider>)
}

describe('LocalizationPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue(locales)
    vi.mocked(api.post).mockResolvedValue({})
    vi.mocked(api.patch).mockResolvedValue({})
    vi.mocked(api.delete).mockResolvedValue(undefined)
  })

  it('opens the default locale first with English placeholders', async () => {
    renderPage()

    expect(await screen.findByRole('heading', { name: 'English' })).toBeInTheDocument()
    expect(screen.getByText(/English is the built-in default/)).toBeInTheDocument()
    expect(screen.getByPlaceholderText('All systems operational.')).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'Set as Default' })).not.toBeInTheDocument()
  })

  it('edits and saves a translation', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: /Polski/ }))
    expect(screen.getByDisplayValue('Działa')).toBeInTheDocument()
    expect(screen.getByText(/Polish has built-in defaults/)).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('Wszystkie systemy działają.'), 'Wszystko działa.')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/locales/pl', {
      translations: { 'status.operational': 'Działa', 'overall.allOperational': 'Wszystko działa.' },
    }))
    expect(await screen.findByRole('button', { name: 'Saved!' })).toBeInTheDocument()
  })

  it('falls back to English placeholders for a language without built-in defaults', async () => {
    const user = userEvent.setup()
    vi.mocked(api.get).mockResolvedValue([...locales, { code: 'de', name: 'Deutsch', isDefault: 0, translations: {} }])
    renderPage()

    await user.click(await screen.findByRole('button', { name: /Deutsch/ }))
    expect(screen.getByText(/no built-in defaults/)).toBeInTheDocument()
    expect(screen.getByPlaceholderText('All systems operational.')).toHaveValue('')
  })

  it('sets a locale as default and deletes it', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: /Polski/ }))
    await user.click(screen.getByRole('button', { name: 'Set as Default' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/locales/pl/set-default', {}))

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete language' })
    expect(api.delete).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Delete language' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/locales/pl'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('creates a language and shows server errors', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: /Add Language/ }))
    const create = screen.getByRole('button', { name: 'Create Language' })
    expect(create).toBeDisabled()
    await user.type(screen.getByPlaceholderText('Code (e.g. pl, de, fr)'), ' DE ')
    await user.type(screen.getByPlaceholderText('Name (e.g. Polski, Deutsch)'), 'Deutsch')

    vi.mocked(api.post).mockRejectedValueOnce(new Error('Locale already exists'))
    await user.click(create)
    expect(await screen.findByText('Locale already exists')).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('Name (e.g. Polski, Deutsch)'), '{Enter}')
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/admin/locales', { code: 'de', name: 'Deutsch' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Create Language' })).not.toBeInTheDocument())
  })

  it('offers every translation key with an associated label', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'English' })

    const editor = screen.getByRole('heading', { name: 'English' }).closest('div.flex-col') as HTMLElement
    expect(within(editor).getAllByRole('textbox')).toHaveLength(Object.keys(EN_DEFAULTS).length)
    expect(screen.getByLabelText('chart.noData')).toBeInTheDocument()
    expect(screen.getByLabelText('overall.noServices')).toBeInTheDocument()
    expect(screen.getByLabelText('incident.impact.major')).toBeInTheDocument()
    // One textbox per translation key makes the role query slow, so the default 5 s is too tight on a loaded CI runner.
  }, 20_000)

  it('asks before discarding unsaved edits when switching language', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(await screen.findByPlaceholderText('All systems operational.'), 'Everything fine')
    await user.click(screen.getByRole('button', { name: /Polski/ }))
    const dialog = screen.getByRole('dialog', { name: 'Discard unsaved changes?' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('heading', { name: 'English' })).toBeInTheDocument()
    expect(screen.getByDisplayValue('Everything fine')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Polski/ }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard changes' }))
    expect(screen.getByRole('heading', { name: 'Polski' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /English/ }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'English' })).toBeInTheDocument()
  })

  it('switches freely after saving', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(await screen.findByPlaceholderText('All systems operational.'), 'Fine')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await screen.findByRole('button', { name: 'Saved!' })
    await user.click(screen.getByRole('button', { name: /Polski/ }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Polski' })).toBeInTheDocument()
  })

  it('prompts to pick a language when none exist', async () => {
    vi.mocked(api.get).mockResolvedValue([])
    renderPage()

    expect(await screen.findByText('Select a language to edit translations.')).toBeInTheDocument()
  })
})
