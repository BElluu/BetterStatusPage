import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary, isChunkLoadError } from './ErrorBoundary'

function Boom({ message }: { message: string }): never {
  throw new Error(message)
}

describe('ErrorBoundary', () => {
  afterEach(() => vi.restoreAllMocks())

  it('renders children when nothing fails', () => {
    render(<ErrorBoundary><p>ok</p></ErrorBoundary>)
    expect(screen.getByText('ok')).toBeTruthy()
  })

  it('shows a reload button for a render error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary><Boom message="bad" /></ErrorBoundary>)
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong')
    expect(screen.getByRole('button', { name: /reload/i })).toBeTruthy()
  })

  it('explains a failed chunk import as a new version', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary><Boom message="Failed to fetch dynamically imported module: /assets/x.js" /></ErrorBoundary>)
    expect(screen.getByRole('alert').textContent).toContain('A new version is available')
  })

  it('recognises chunk errors', () => {
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(new Error('x is undefined'))).toBe(false)
  })
})

describe('ErrorBoundary reload', () => {
  it('reloads the page when Reload is clicked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    render(<ErrorBoundary><Boom message="bad" /></ErrorBoundary>)
    await userEvent.click(screen.getByRole('button', { name: /reload/i }))
    expect(reload).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
})
