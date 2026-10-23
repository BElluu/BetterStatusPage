import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

function Boom(): never {
  throw new Error('bad')
}

describe('ErrorBoundary', () => {
  afterEach(() => vi.restoreAllMocks())

  it('renders children when nothing fails', () => {
    render(<ErrorBoundary><p>ok</p></ErrorBoundary>)
    expect(screen.getByText('ok')).toBeTruthy()
  })

  it('shows a reload button when rendering fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })
})

describe('ErrorBoundary reload', () => {
  it('reloads the page when Reload is clicked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
})
