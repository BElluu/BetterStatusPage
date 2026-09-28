import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import BrandingPage from './Branding'
import { api } from '../api/client'

vi.mock('../api/client', () => ({
  isAuthenticated: () => false,
  api: {
    get: vi.fn(() => new Promise(() => {})),
    patch: vi.fn(),
    upload: vi.fn(),
  },
}))

describe('BrandingPage localization', () => {
  it('renders the controls in English by default', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <BrandingPage />
      </QueryClientProvider>,
    )

    expect(screen.getByText('Public status page appearance')).toBeInTheDocument()
    expect(screen.getByText('Identity')).toBeInTheDocument()
    expect(screen.queryByText(/always active/i)).not.toBeInTheDocument()
    expect(screen.getAllByText('Choose image')).toHaveLength(2)
    expect(screen.getAllByText('No file selected')).toHaveLength(2)
    expect(screen.getByText('Light mode logo')).toBeInTheDocument()
    expect(screen.getByText('Dark mode logo')).toBeInTheDocument()
    expect(screen.getByText('Used in the browser tab title and page footer. It does not replace the logo.')).toBeInTheDocument()
    expect(screen.getByText('Custom branding')).toBeInTheDocument()
    expect(screen.getByText('Backgrounds')).toBeInTheDocument()
    expect(screen.getByText('Charts')).toBeInTheDocument()
    expect(screen.getByText('Chart grid lines')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save branding' })).toBeInTheDocument()
    expect(screen.getByText('Live preview')).toBeInTheDocument()
    expect(screen.getByTitle('Public status page preview')).toBeInTheDocument()
    expect(screen.getByText(/saved Page Builder layout/)).toBeInTheDocument()

    const cssEditorButton = screen.getByRole('button', { name: 'Open CSS editor' })
    expect(cssEditorButton).toBeDisabled()
    expect(Array.from(container.querySelectorAll<HTMLInputElement>('input[type="color"]')).every((input) => input.matches(':disabled'))).toBe(true)
    expect(screen.getByText('Enable custom branding to edit and apply custom CSS.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'Custom branding' }))
    expect(cssEditorButton).toBeEnabled()
    expect(Array.from(container.querySelectorAll<HTMLInputElement>('input[type="color"]')).every((input) => input.matches(':enabled'))).toBe(true)
    expect(screen.getByText('Universal logo')).toBeInTheDocument()
    fireEvent.click(cssEditorButton)
    expect(screen.getByRole('dialog', { name: 'Custom CSS editor' })).toBeInTheDocument()
    expect(screen.getByText('.bsp-chart-card')).toBeInTheDocument()
    expect(screen.getByText('--bsp-chart-bg')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Custom CSS editor' })).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Custom branding' })).toHaveAttribute('aria-checked', 'true')

    expect(screen.queryByText('Tożsamość')).not.toBeInTheDocument()
    expect(screen.queryByText('Zapisz branding')).not.toBeInTheDocument()
    expect(screen.queryByText('Podgląd na żywo')).not.toBeInTheDocument()
  })

  it('does not upload a pending logo after switching to a mode where it is hidden', async () => {
    vi.clearAllMocks()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <BrandingPage />
      </QueryClientProvider>,
    )
    const lightLogoInput = container.querySelector<HTMLInputElement>('#branding-logo-light')!
    fireEvent.change(lightLogoInput, { target: { files: [new File(['logo'], 'light.png', { type: 'image/png' })] } })
    fireEvent.click(screen.getByRole('switch', { name: 'Custom branding' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }))

    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    expect(api.upload).not.toHaveBeenCalled()
  })
})

describe('BrandingPage loading', () => {
  it('keeps edits made before the saved branding finishes loading', async () => {
    vi.clearAllMocks()
    let resolveBranding: (value: unknown) => void = () => {}
    vi.mocked(api.get).mockImplementation((path: string) => path === '/admin/branding'
      ? new Promise((resolve) => { resolveBranding = resolve })
      : new Promise(() => {}))
    vi.mocked(api.patch).mockResolvedValue({})
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <BrandingPage />
      </QueryClientProvider>,
    )

    fireEvent.change(screen.getByPlaceholderText('My Status Page'), { target: { value: 'Acme Status' } })
    resolveBranding({ enabled: 0, siteName: 'Stored name', logoType: 'image', logoText: '', logoUrl: null, logoLightUrl: null, logoDarkUrl: null, primaryColor: '#000000', accentColor: '#497cff' })
    // The loaded branding arrives after the edit; it must not replace it.
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Custom branding' })).toBeInTheDocument())
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(screen.getByPlaceholderText('My Status Page')).toHaveValue('Acme Status')
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/branding', expect.objectContaining({ siteName: 'Acme Status' })))
  })
})

describe('BrandingPage page header', () => {
  it('turns the page header, footer and project link off in the saved branding', async () => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockImplementation((path: string) => path === '/admin/branding'
      ? Promise.resolve({ enabled: 0, showHero: 1, showFooter: 1, showProjectLink: 1, siteName: 'Status', logoType: 'image', logoText: '', logoUrl: null, logoLightUrl: null, logoDarkUrl: null, primaryColor: '#000000', accentColor: '#497cff' })
      : new Promise(() => {}))
    vi.mocked(api.patch).mockResolvedValue({})
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><BrandingPage /></QueryClientProvider>)

    const headerSwitch = await screen.findByRole('switch', { name: 'Page header' })
    await waitFor(() => expect(headerSwitch).toHaveAttribute('aria-checked', 'true'))
    // Works without custom branding, like the uptime thresholds.
    expect(headerSwitch).toBeEnabled()
    fireEvent.click(headerSwitch)
    expect(headerSwitch).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByRole('switch', { name: 'Footer' }))
    expect(screen.getByText(/Thank you for keeping it!/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'BetterStatusPage link' }))
    expect(screen.getByText('Hidden. No hard feelings. Well, maybe a few.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/branding', expect.objectContaining({ showHero: 0, showFooter: 0, showProjectLink: 0 })))
  })
})

describe('BrandingPage uptime thresholds', () => {
  it('derives the Down limit from Partial outage and blocks saving limits out of order', async () => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockImplementation(() => new Promise(() => {}))
    vi.mocked(api.patch).mockResolvedValue({})
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <BrandingPage />
      </QueryClientProvider>,
    )

    fireEvent.change(screen.getByLabelText('Partial outage from (%)'), { target: { value: '80' } })
    expect(screen.getByLabelText('Down below (%)')).toHaveTextContent('80')

    fireEvent.change(screen.getByLabelText('Degraded from (%)'), { target: { value: '99.95' } })
    expect(screen.getByRole('alert')).toHaveTextContent(/descending/)
    expect(screen.getByRole('button', { name: 'Save branding' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Degraded from (%)'), { target: { value: '95' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/branding', expect.objectContaining({
      uptimeThresholdUp: 99.9, uptimeThresholdDegraded: 95, uptimeThresholdPartial: 80,
    })))
  })
})
