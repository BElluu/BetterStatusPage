import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AdminStaticMirror } from '@bsp/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import StaticFallbackPage from './StaticFallback'

vi.mock('../api/client', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }))

const MASK = '••••••••'

const OFF: AdminStaticMirror = {
  settings: { enabled: false, endpoint: '', region: 'auto', bucket: '', accessKeyId: '', secretAccessKey: '', intervalSeconds: 60, showBanner: true },
  status: { lastRunAt: null, lastSuccessAt: null, lastError: null, lastUploadedFiles: 0, copyFiles: null, copyBytes: null },
  health: 'disabled',
  runs: [],
}

function running(over: Partial<AdminStaticMirror> = {}): AdminStaticMirror {
  const at = Date.now() - 30_000
  return {
    settings: {
      enabled: true, endpoint: 'https://abc.r2.cloudflarestorage.com', region: 'auto', bucket: 'status-copy', accessKeyId: 'AKID',
      secretAccessKey: MASK, intervalSeconds: 60, showBanner: true,
    },
    status: { lastRunAt: at, lastSuccessAt: at, lastError: null, lastUploadedFiles: 1, copyFiles: 16, copyBytes: 1_468_006 },
    health: 'ok',
    runs: [{ at: at - 120_000, ok: true, uploadedFiles: 16, error: null }, { at: at - 60_000, ok: true, uploadedFiles: 1, error: null }, { at, ok: true, uploadedFiles: 1, error: null }],
    ...over,
  }
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><StaticFallbackPage /></QueryClientProvider>)
}

describe('StaticFallbackPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue(OFF)
  })

  describe('before anything is set up', () => {
    it('walks through the three steps and cannot push', async () => {
      renderPage()

      expect(await screen.findByRole('heading', { name: 'Not set up yet' })).toBeInTheDocument()
      expect(screen.getByText('Create a bucket')).toBeInTheDocument()
      expect(screen.getByText('Check, then turn it on')).toBeInTheDocument()
      const push = screen.getByRole('button', { name: 'Push now' })
      expect(push).toBeDisabled()
      expect(push).toHaveAttribute('title', 'Turn the mirror on and save first')
      expect(screen.getByRole('button', { name: 'Save and turn on' })).toBeDisabled()
    })

    it('fills in the region of the chosen provider and explains where to find the rest', async () => {
      const user = userEvent.setup()
      renderPage()

      expect(await screen.findByText(/R2 → your bucket → Settings/)).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'AWS S3' }))
      expect(screen.getByLabelText('Region')).toHaveValue('')
      expect(screen.getByText(/Create an IAM user/)).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'MinIO / other' }))
      expect(screen.getByLabelText('Region')).toHaveValue('us-east-1')

      // A region the person typed is theirs.
      await user.clear(screen.getByLabelText('Region'))
      await user.type(screen.getByLabelText('Region'), 'eu-west-9')
      await user.click(screen.getByRole('button', { name: 'Backblaze B2' }))
      expect(screen.getByLabelText('Region')).toHaveValue('eu-west-9')
    })

    it('saves the target and turns it on in one step', async () => {
      const user = userEvent.setup()
      vi.mocked(api.put).mockImplementation(async (_path, body) => running({ settings: { ...(body as AdminStaticMirror['settings']), secretAccessKey: MASK } }))
      renderPage()

      await user.type(await screen.findByLabelText('Bucket'), 'status-copy')
      await user.type(screen.getByLabelText('Endpoint'), 'https://abc.r2.cloudflarestorage.com')
      await user.type(screen.getByLabelText('Access key ID'), 'AKID')
      await user.type(screen.getByLabelText('Secret access key'), 'topsecret')
      await user.click(screen.getByRole('button', { name: 'Save and turn on' }))

      await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/static-mirror', expect.objectContaining({
        enabled: true, bucket: 'status-copy', accessKeyId: 'AKID', secretAccessKey: 'topsecret', endpoint: 'https://abc.r2.cloudflarestorage.com',
      })))
      expect(await screen.findByRole('heading', { name: 'The copy is up to date' })).toBeInTheDocument()
      expect(screen.getByLabelText('Secret access key')).toHaveValue(MASK)
    })

    it('shows why the settings were refused', async () => {
      const user = userEvent.setup()
      vi.mocked(api.put).mockRejectedValue(new Error('The status page is private, so it cannot be mirrored to public hosting'))
      renderPage()

      await user.type(await screen.findByLabelText('Bucket'), 'status-copy')
      await user.type(screen.getByLabelText('Access key ID'), 'AKID')
      await user.type(screen.getByLabelText('Secret access key'), 'topsecret')
      await user.click(screen.getByRole('button', { name: 'Save and turn on' }))

      expect(await screen.findByText(/status page is private/)).toBeInTheDocument()
    })
  })

  it('points to the guide on sending visitors to the copy', async () => {
    renderPage()

    expect(await screen.findByRole('link', { name: 'How to set that up' })).toHaveAttribute('href', 'https://docs.betterstatuspage.dev/static-fallback/')
  })

  describe('checking access', () => {
    async function fillAndCheck() {
      const user = userEvent.setup()
      renderPage()
      const check = await screen.findByRole('button', { name: 'Check access' })
      expect(check).toBeDisabled()
      await user.type(screen.getByLabelText('Bucket'), 'status-copy')
      await user.type(screen.getByLabelText('Access key ID'), 'AKID')
      await user.type(screen.getByLabelText('Secret access key'), 'topsecret')
      await user.click(check)
    }

    it('tries the values of the form, saved or not', async () => {
      vi.mocked(api.post).mockResolvedValue({ ok: true, error: null })
      await fillAndCheck()

      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/static-mirror/check', expect.objectContaining({ bucket: 'status-copy', secretAccessKey: 'topsecret' })))
      expect(await screen.findByText('Connected. The key can write to status-copy.')).toBeInTheDocument()
    })

    it('says what the service rejected', async () => {
      vi.mocked(api.post).mockResolvedValue({ ok: false, error: 'Upload of .bsp-access-check failed: HTTP 403 AccessDenied' })
      await fillAndCheck()

      expect(await screen.findByText(/Rejected by the service: .*HTTP 403 AccessDenied/)).toBeInTheDocument()
    })

    it('does not call a network failure a rejection', async () => {
      vi.mocked(api.post).mockResolvedValue({ ok: false, error: 'fetch failed (ENOTFOUND)' })
      await fillAndCheck()

      expect(await screen.findByText(/Could not reach the service: fetch failed \(ENOTFOUND\)/)).toBeInTheDocument()
    })
  })

  describe('right after it was turned on', () => {
    it('does not claim the copy is up to date before the first push', async () => {
      vi.mocked(api.get).mockResolvedValue(running({
        health: 'pending',
        status: { lastRunAt: null, lastSuccessAt: null, lastError: null, lastUploadedFiles: 0, copyFiles: null, copyBytes: null },
        runs: [],
      }))
      renderPage()

      expect(await screen.findByRole('heading', { name: 'Waiting for the first push' })).toBeInTheDocument()
      expect(screen.getByText('Waiting')).toBeInTheDocument()
      expect(screen.queryByText(/null/)).not.toBeInTheDocument()
    })
  })

  describe('turning on a saved target', () => {
    it('sends the mask of the saved secret, not an empty one', async () => {
      const user = userEvent.setup()
      vi.mocked(api.get).mockResolvedValue(running({ health: 'disabled', settings: { ...running().settings, enabled: false } }))
      vi.mocked(api.put).mockResolvedValue(running())
      renderPage()

      await user.click(await screen.findByRole('button', { name: 'Save and turn on' }))

      await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/static-mirror', expect.objectContaining({ enabled: true, secretAccessKey: MASK })))
    })

    it('does not send an interval under a minute', async () => {
      const user = userEvent.setup()
      renderPage()

      await user.click(await screen.findByRole('button', { name: 'Custom' }))
      const input = screen.getByLabelText('Interval in seconds')
      await user.clear(input)
      await user.type(input, '30')
      await user.click(screen.getByRole('button', { name: 'Save' }))

      // The field itself refuses it, before the server is asked.
      expect(input).toBeInvalid()
      expect(api.put).not.toHaveBeenCalled()
    })
  })

  describe('while it runs', () => {
    beforeEach(() => { vi.mocked(api.get).mockResolvedValue(running()) })

    it('tells the state in words, with the size of the copy and the latest pushes', async () => {
      renderPage()

      expect(await screen.findByRole('heading', { name: 'The copy is up to date' })).toBeInTheDocument()
      expect(screen.getByText(/visitors who are sent to the copy still see the last known state/)).toBeInTheDocument()
      expect(screen.getByText('16 files · 1.4 MB')).toBeInTheDocument()
      expect(screen.getByText('1 file')).toBeInTheDocument()
      expect(screen.getByRole('img', { name: '3 of the last 3 pushes succeeded' })).toBeInTheDocument()
    })

    it('pushes on demand', async () => {
      const user = userEvent.setup()
      vi.mocked(api.post).mockResolvedValue(running())
      renderPage()

      await user.click(await screen.findByRole('button', { name: 'Push now' }))

      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/static-mirror/test'))
    })

    it('asks to save before pushing changed settings', async () => {
      const user = userEvent.setup()
      renderPage()

      await user.type(await screen.findByLabelText('Bucket'), '-2')

      expect(screen.getByRole('button', { name: 'Push now' })).toBeDisabled()
      expect(screen.getByText('You have unsaved changes.')).toBeInTheDocument()
    })

    it('keeps the saved secret unless it is replaced', async () => {
      const user = userEvent.setup()
      vi.mocked(api.put).mockImplementation(async (_path, body) => running({ settings: { ...(body as AdminStaticMirror['settings']), secretAccessKey: MASK } }))
      renderPage()

      const secret = await screen.findByLabelText('Secret access key')
      expect(secret).toHaveValue(MASK)
      expect(secret).toHaveAttribute('readonly')

      await user.click(screen.getByRole('button', { name: 'Replace' }))
      await user.type(screen.getByLabelText('Secret access key'), 'newsecret')
      await user.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/static-mirror', expect.objectContaining({ secretAccessKey: 'newsecret' })))
    })

    it('can go back to the saved secret after choosing to replace it', async () => {
      const user = userEvent.setup()
      renderPage()

      await user.click(await screen.findByRole('button', { name: 'Replace' }))
      await user.click(screen.getByRole('button', { name: 'Keep saved' }))

      expect(screen.getByLabelText('Secret access key')).toHaveValue(MASK)
      expect(screen.getByText('All changes saved.')).toBeInTheDocument()
    })

    it('can switch the banner on the copy off', async () => {
      const user = userEvent.setup()
      vi.mocked(api.put).mockImplementation(async (_path, body) => running({ settings: { ...(body as AdminStaticMirror['settings']), secretAccessKey: MASK } }))
      renderPage()

      expect(await screen.findByText(/Last saved state from/)).toBeInTheDocument()
      await user.click(screen.getByRole('switch', { name: 'Show a banner on the copy' }))
      expect(screen.getByText(/Visitors get no warning when the copy is old/)).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/static-mirror', expect.objectContaining({ showBanner: false })))
    })
  })

  describe('when a push fails', () => {
    it('shows the error, counts the failures and offers to try again', async () => {
      const at = Date.now() - 30_000
      vi.mocked(api.get).mockResolvedValue(running({
        health: 'error',
        status: { lastRunAt: at, lastSuccessAt: at - 600_000, lastError: 'Upload of snapshot.json failed: HTTP 403 AccessDenied', lastUploadedFiles: 0, copyFiles: 16, copyBytes: 1_468_006 },
        runs: [
          { at: at - 180_000, ok: true, uploadedFiles: 1, error: null },
          { at: at - 120_000, ok: false, uploadedFiles: 0, error: 'Upload of snapshot.json failed: HTTP 403 AccessDenied' },
          { at: at - 60_000, ok: false, uploadedFiles: 0, error: 'Upload of snapshot.json failed: HTTP 403 AccessDenied' },
          { at, ok: false, uploadedFiles: 0, error: 'Upload of snapshot.json failed: HTTP 403 AccessDenied' },
        ],
      }))
      renderPage()

      expect(await screen.findByRole('heading', { name: 'The copy is going out of date' })).toBeInTheDocument()
      expect(screen.getByText(/The last 3 pushes failed/)).toBeInTheDocument()
      expect(screen.getByText('Upload of snapshot.json failed: HTTP 403 AccessDenied')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
      expect(screen.getByRole('img', { name: '1 of the last 4 pushes succeeded' })).toBeInTheDocument()
    })
  })
})
