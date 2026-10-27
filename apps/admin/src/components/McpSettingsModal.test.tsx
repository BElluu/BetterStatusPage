import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { McpSettingsModal } from './McpSettingsModal'

vi.mock('../api/client', () => ({ api: { get: vi.fn(), put: vi.fn() } }))

interface Settings { enabled: boolean; allowChanges: boolean; publicUrl: string | null }
const OFF: Settings = { enabled: false, allowChanges: false, publicUrl: 'https://status.example.com' }

function renderCard() {
  const onClose = vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><McpSettingsModal onClose={onClose} /></QueryClientProvider>)
  return onClose
}

/** The server answers a change with the settings that result, the way the route does. */
function serverStartingWith(start: Settings) {
  let current = start
  vi.mocked(api.get).mockImplementation(async () => current)
  vi.mocked(api.put).mockImplementation(async (_path, body) => {
    const change = body as Partial<Settings>
    const enabled = change.enabled ?? current.enabled
    current = { ...current, enabled, allowChanges: enabled && (change.allowChanges ?? current.allowChanges) }
    return current
  })
}

describe('McpSettingsModal', () => {
  beforeEach(() => vi.clearAllMocks())

  it('starts off, shows no address, and asks for the password before turning MCP on', async () => {
    const user = userEvent.setup()
    serverStartingWith(OFF)
    renderCard()

    const connect = await screen.findByRole('switch', { name: 'Allow AI agents to connect' })
    expect(connect).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByText('https://status.example.com/mcp')).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Allow agents to make changes' })).not.toBeInTheDocument()

    await user.click(connect)
    expect(api.put).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Turn on MCP' })).toBeInTheDocument()

    await user.type(screen.getByLabelText('Your current password'), 'correct horse')
    await user.click(screen.getByRole('button', { name: 'Turn on' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/mcp', { enabled: true, currentPassword: 'correct horse' }))
    expect(await screen.findByText('https://status.example.com/mcp')).toBeInTheDocument()
    expect(screen.getByText(/claude mcp add --transport http bsp "https:\/\/status\.example\.com\/mcp"/)).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Allow AI agents to connect' })).toHaveAttribute('aria-checked', 'true')
  })

  it('shows a refusal in the dialog and keeps MCP off', async () => {
    const user = userEvent.setup()
    serverStartingWith(OFF)
    vi.mocked(api.put).mockRejectedValueOnce(new Error('Current password is incorrect'))
    renderCard()

    await user.click(await screen.findByRole('switch', { name: 'Allow AI agents to connect' }))
    await user.type(screen.getByLabelText('Your current password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Turn on' }))

    expect(await screen.findByText('Current password is incorrect')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Turn on MCP' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Allow AI agents to connect' })).toHaveAttribute('aria-checked', 'false')
  })

  it('keeps agents read-only until changes are allowed, which is confirmed too', async () => {
    const user = userEvent.setup()
    serverStartingWith({ ...OFF, enabled: true })
    renderCard()

    const changes = await screen.findByRole('switch', { name: 'Allow agents to make changes' })
    expect(changes).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/Agents are read-only/)).toBeInTheDocument()

    await user.click(changes)
    expect(api.put).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('Your current password'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Turn on' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/mcp', { allowChanges: true, currentPassword: 'pw' }))
    expect(await screen.findByText(/Agents can change data/)).toBeInTheDocument()
  })

  it('turns changes and MCP off at once, without a password', async () => {
    const user = userEvent.setup()
    serverStartingWith({ ...OFF, enabled: true, allowChanges: true })
    renderCard()

    await user.click(await screen.findByRole('switch', { name: 'Allow agents to make changes' }))
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/mcp', { allowChanges: false }))
    expect(screen.queryByRole('dialog', { name: /Turn on|Allow agents/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('switch', { name: 'Allow AI agents to connect' }))
    await waitFor(() => expect(api.put).toHaveBeenLastCalledWith('/admin/mcp', { enabled: false }))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Allow AI agents to connect' })).toHaveAttribute('aria-checked', 'false'))
    expect(screen.queryByRole('switch', { name: 'Allow agents to make changes' })).not.toBeInTheDocument()
  })

  it('is a dialog of its own that closes with Close', async () => {
    const user = userEvent.setup()
    serverStartingWith(OFF)
    const onClose = renderCard()
    expect(await screen.findByRole('dialog', { name: 'MCP for AI agents' })).toBeInTheDocument()
    const closers = screen.getAllByRole('button', { name: 'Close' })
    expect(closers).toHaveLength(2)
    for (const closer of closers) await user.click(closer)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('falls back to the address of this page when the server has no public URL', async () => {
    serverStartingWith({ enabled: true, allowChanges: false, publicUrl: null })
    renderCard()
    expect(await screen.findByText(`${window.location.origin}/mcp`)).toBeInTheDocument()
  })

  it('offers a retry when the settings cannot be loaded', async () => {
    const user = userEvent.setup()
    vi.mocked(api.get).mockRejectedValueOnce(new Error('boom')).mockResolvedValue(OFF)
    renderCard()
    await user.click(await screen.findByRole('button', { name: /retry|try again/i }))
    expect(await screen.findByRole('switch', { name: 'Allow AI agents to connect' })).toBeInTheDocument()
  })
})
