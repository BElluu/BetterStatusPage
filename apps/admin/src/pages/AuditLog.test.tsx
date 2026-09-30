import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import AuditLogPage from './AuditLog'

vi.mock('../api/client', () => ({
  api: { get: vi.fn() },
}))

const entries = [
  {
    id: 1, timestamp: Date.UTC(2026, 8, 1, 12), userEmail: 'owner@example.test', action: 'update',
    entityType: 'monitor', entityName: 'Checkout API', diff: { intervalSecs: { from: 60, to: 30 }, description: { from: null, to: 'prod' } },
  },
  {
    id: 2, timestamp: Date.UTC(2026, 8, 1, 11), userEmail: 'owner@example.test', action: 'create',
    entityType: 'vault_secret', entityName: 'db-login', diff: { name: 'db-login', type: 'userpass', note: null },
  },
  { id: 3, timestamp: Date.UTC(2026, 8, 1, 10), userEmail: 'ops@example.test', action: 'delete', entityType: 'user', entityName: 'old@example.test', diff: null },
  { id: 4, timestamp: Date.UTC(2026, 8, 1, 9), userEmail: 'ops@example.test', action: 'delete', entityType: 'legacy_thing', entityName: 'X', diff: {} },
]

let pages = 1

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><AuditLogPage /></QueryClientProvider>)
}

function lastQuery() {
  const calls = vi.mocked(api.get).mock.calls
  return new URLSearchParams(String(calls.at(-1)![0]).split('?')[1])
}

describe('AuditLogPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pages = 1
    vi.mocked(api.get).mockImplementation(async () => ({ entries, total: entries.length * pages, page: 1, limit: 50, pages }))
  })

  it('lists entries with action and entity labels', async () => {
    renderPage()

    expect(await screen.findByText('4 entries')).toBeInTheDocument()
    expect(screen.getByText('Checkout API')).toBeInTheDocument()
    expect(screen.getByText('Vault Secret', { selector: 'div' })).toBeInTheDocument()
    expect(screen.getByText('legacy_thing')).toBeInTheDocument()
    expect(screen.getByText('2 fields changed')).toBeInTheDocument()
    expect(screen.getAllByText('Delete', { selector: 'span' })).toHaveLength(2)
    expect(api.get).toHaveBeenCalledWith('/admin/audit?page=1&limit=50')
  })

  it('expands an update into a before/after diff and a create into a snapshot', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByText('2 fields changed'))
    expect(screen.getByRole('columnheader', { name: 'Before' })).toBeInTheDocument()
    expect(screen.getByText('60')).toBeInTheDocument()
    expect(screen.getByText('30')).toBeInTheDocument()
    expect(screen.getByText('Hide details')).toBeInTheDocument()

    await user.click(screen.getByText('3 fields changed'))
    expect(screen.queryByRole('columnheader', { name: 'Before' })).not.toBeInTheDocument()
    expect(screen.getByText('name:')).toBeInTheDocument()
    expect(screen.getByText('null')).toBeInTheDocument()
  })

  it('sends filters to the server and clears them', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('4 entries')

    await user.type(screen.getByPlaceholderText('Filter by email…'), 'ops{Enter}')
    const [entity, action] = screen.getAllByRole('combobox')
    await user.selectOptions(entity!, 'vault')
    await user.selectOptions(action!, 'delete')
    const [from, to] = document.querySelectorAll('input[type="date"]')
    fireEvent.change(from!, { target: { value: '2026-09-01' } })
    fireEvent.change(to!, { target: { value: '2026-09-02' } })

    await waitFor(() => {
      const query = lastQuery()
      expect(query.get('userEmail')).toBe('ops')
      expect(query.get('entityType')).toBe('vault')
      expect(query.get('action')).toBe('delete')
      expect(query.get('from')).toBe(String(new Date('2026-09-01').getTime()))
      expect(query.get('to')).toBe(String(new Date('2026-09-02T23:59:59').getTime()))
    })

    await user.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/admin/audit?page=1&limit=50'))
  })

  it('pages through results', async () => {
    const user = userEvent.setup()
    pages = 3
    renderPage()

    expect(await screen.findByText('Page 1 of 3 · 12 entries')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    expect(await screen.findByText('Page 2 of 3 · 12 entries')).toBeInTheDocument()
    await waitFor(() => expect(lastQuery().get('page')).toBe('2'))
    await user.click(screen.getByRole('button', { name: 'Previous page' }))
    expect(await screen.findByText('Page 1 of 3 · 12 entries')).toBeInTheDocument()
  })

  it('exposes the expand control as a button with aria-expanded', async () => {
    const user = userEvent.setup()
    renderPage()
    const toggle = await screen.findByRole('button', { name: /2 fields changed/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(screen.getByRole('button', { name: /Hide details/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('debounces the email search', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('4 entries')
    const callsBefore = vi.mocked(api.get).mock.calls.length
    await user.type(screen.getByLabelText('User'), 'abc')
    expect(vi.mocked(api.get).mock.calls.length).toBe(callsBefore)
    await waitFor(() => expect(lastQuery().get('userEmail')).toBe('abc'))
    expect(vi.mocked(api.get).mock.calls.filter(([url]) => String(url).includes('userEmail'))).toHaveLength(1)
  })

  it('shows an error state with retry', async () => {
    const user = userEvent.setup()
    vi.mocked(api.get).mockRejectedValueOnce(new Error('boom'))
    renderPage()
    expect(await screen.findByText('Could not load the audit log.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Try again/ }))
    expect(await screen.findByText('4 entries')).toBeInTheDocument()
  })

  it('shows an empty state', async () => {
    vi.mocked(api.get).mockResolvedValue({ entries: [], total: 0, page: 1, limit: 50, pages: 1 })
    renderPage()

    expect(await screen.findByText('No audit entries found.')).toBeInTheDocument()
    expect(screen.getByText('Timestamp')).toBeInTheDocument()
    expect(screen.getByText('Changes made in the admin panel and refused SSO sign-ins are recorded here.')).toBeInTheDocument()
  })
})
