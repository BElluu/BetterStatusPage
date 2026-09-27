import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import BackupsPage from './Backups'

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), upload: vi.fn(), download: vi.fn() },
}))

const baseConfig = { enabled: true, frequency: 'daily', hour: 3, minute: 5, weekday: 1, retention: 7 }

function state(overrides: Record<string, unknown> = {}) {
  return {
    backups: [{ filename: 'bsp-2026-09-01.backup', size: 2 * 1024 * 1024, createdAt: Date.UTC(2026, 8, 1) }],
    config: baseConfig,
    status: { state: 'error', lastCompletedAt: Date.UTC(2026, 8, 1), lastFilename: null, lastError: 'disk full' },
    ...overrides,
  }
}

describe('BackupsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue(state())
    vi.mocked(api.post).mockResolvedValue({})
    vi.mocked(api.delete).mockResolvedValue(undefined)
    vi.mocked(api.put).mockImplementation(async (_path: string, body: unknown) => body)
  })

  it('lists backups with the schedule and last run', async () => {
    renderPage()

    expect(await screen.findByText('bsp-2026-09-01.backup')).toBeInTheDocument()
    expect(screen.getByText(/2\.00 MB/)).toBeInTheDocument()
    expect(screen.getByText('Every day at 03:05 · keep 7 backups')).toBeInTheDocument()
    expect(screen.getByText(/· error · disk full$/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Saved' })).toBeDisabled()
  })

  it('shows the error instead of the loading text when the backups request fails', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('Forbidden'))
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('Forbidden')
    expect(screen.queryByText('Loading backups…')).not.toBeInTheDocument()
  })

  it('creates a backup and reports failures', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Create backup' }))
    expect(await screen.findByText('Backup created successfully.')).toBeInTheDocument()
    expect(api.post).toHaveBeenCalledWith('/admin/backups', {})

    vi.mocked(api.post).mockRejectedValueOnce(new Error('Backup already running'))
    await user.click(screen.getByRole('button', { name: 'Create backup' }))
    expect(await screen.findByText('Backup already running')).toBeInTheDocument()
  })

  it('edits and saves a weekly schedule', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Weekly' }))
    await user.selectOptions(screen.getByRole('combobox'), '5')
    fireEvent.change(screen.getByDisplayValue('03:05'), { target: { value: '22:30' } })
    const retention = screen.getByDisplayValue('7')
    await user.clear(retention)
    await user.type(retention, '1')
    expect(screen.getByText('Every Friday at 22:30 · keep 1 backup')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save schedule' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/backups/config', {
      enabled: true, frequency: 'weekly', hour: 22, minute: 30, weekday: 5, retention: 1,
    }))
    expect(await screen.findByText('Schedule saved.')).toBeInTheDocument()
  })

  it('disables automatic backups', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('switch', { name: 'Automatic backups' }))
    expect(screen.getByText('Automatic backups are disabled')).toBeInTheDocument()
    expect(screen.getByText('Enable scheduling to configure recurring backups.')).toBeInTheDocument()
  })

  it('validates a restore file and warns about a mismatched vault key', async () => {
    vi.mocked(api.upload).mockResolvedValue({ manifest: { createdAt: Date.UTC(2026, 8, 1) }, vaultKeyMatches: false })
    renderPage()
    await screen.findByText('bsp-2026-09-01.backup')

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, new File(['x'], 'restore.backup'))

    expect(await screen.findByText(/Backup is valid .* Warning: VAULT_ENCRYPTION_KEY does not match\./)).toBeInTheDocument()
    expect(api.upload).toHaveBeenCalledWith('/admin/backups/validate', expect.any(FormData))
  })

  it('downloads and deletes a backup after typing its name', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Download' }))
    expect(api.download).toHaveBeenCalledWith('/admin/backups/bsp-2026-09-01.backup/download', 'bsp-2026-09-01.backup')

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete backup' })
    const confirm = within(dialog).getByRole('button', { name: 'Delete backup' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByRole('textbox'), 'bsp-2026-09-01.backup')
    await user.click(confirm)

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/backups/bsp-2026-09-01.backup?confirm=bsp-2026-09-01.backup'))
    expect(await screen.findByText('Backup deleted.')).toBeInTheDocument()
  })
})

function renderPage() {
  return render(<BackupsPage />)
}
