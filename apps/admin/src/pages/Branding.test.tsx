import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AdminLocaleProvider } from '../i18n/LocaleContext'
import BrandingPage from './Branding'

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
    render(
      <QueryClientProvider client={queryClient}>
        <AdminLocaleProvider>
          <BrandingPage />
        </AdminLocaleProvider>
      </QueryClientProvider>,
    )

    expect(screen.getByText('Public status page appearance')).toBeInTheDocument()
    expect(screen.getByText('Identity')).toBeInTheDocument()
    expect(screen.getByText('Custom branding')).toBeInTheDocument()
    expect(screen.getByText('Background and cards')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save branding' })).toBeInTheDocument()
    expect(screen.getByText('Live preview')).toBeInTheDocument()

    expect(screen.queryByText('Tożsamość')).not.toBeInTheDocument()
    expect(screen.queryByText('Zapisz branding')).not.toBeInTheDocument()
    expect(screen.queryByText('Podgląd na żywo')).not.toBeInTheDocument()
  })
})
