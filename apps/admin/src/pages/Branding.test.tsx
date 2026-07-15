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
    fireEvent.click(screen.getByRole('button', { name: 'Custom branding' }))
    expect(cssEditorButton).toBeEnabled()
    expect(Array.from(container.querySelectorAll<HTMLInputElement>('input[type="color"]')).every((input) => input.matches(':enabled'))).toBe(true)
    expect(screen.getByText('Universal logo')).toBeInTheDocument()
    fireEvent.click(cssEditorButton)
    expect(screen.getByRole('dialog', { name: 'Custom CSS editor' })).toBeInTheDocument()
    expect(screen.getByText('.bsp-chart-card')).toBeInTheDocument()
    expect(screen.getByText('--bsp-chart-bg')).toBeInTheDocument()

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
    fireEvent.click(screen.getByRole('button', { name: 'Custom branding' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }))

    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    expect(api.upload).not.toHaveBeenCalled()
  })
})
