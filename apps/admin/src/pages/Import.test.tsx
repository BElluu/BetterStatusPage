import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../api/client'
import ImportPage from './Import'

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), postText: vi.fn() } }
})

type Summary = { create: number; update: number; unchanged: number }
const result = (summary: Partial<Summary>, changes: unknown[] = [], dryRun = true) => ({
  dryRun, summary: { create: 0, update: 0, unchanged: 0, ...summary }, changes,
})

const YAML = 'kind: Monitor\nkey: public-site\nname: Public site\ntype: https\n'
const postText = () => vi.mocked(api.postText)
const box = () => screen.getByLabelText('Configuration to import')

function renderPage() {
  render(<ImportPage />)
  return userEvent.setup()
}

/** Pasting is one change event; typing a file by hand would send a check per character. */
const paste = (text = YAML) => fireEvent.change(box(), { target: { value: text } })

const appears = (name: string | RegExp) => waitFor(() => expect(screen.getByRole('button', { name })).toBeInTheDocument(), { timeout: 2000 })

describe('ImportPage', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('says nothing and asks nothing while the box is empty', async () => {
    renderPage()
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(postText()).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument()
  })

  it('checks pasted text and lists what it would change', async () => {
    postText().mockResolvedValueOnce(result({ create: 1, update: 1, unchanged: 3 }, [
      { kind: 'NotificationChannel', key: 'pager', action: 'create' },
      { kind: 'Monitor', key: 'public-site', action: 'update', fields: ['intervalSecs', 'dependsOn'] },
      { kind: 'Monitor', key: 'old', action: 'unchanged' },
    ]))
    renderPage()
    paste()

    await appears('Apply changes')
    expect(postText()).toHaveBeenCalledWith('/admin/config/validate', YAML, 'application/yaml')
    expect(screen.getByText('1 to create · 1 to update · 3 unchanged')).toBeInTheDocument()
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('CreateNotification channelpager')
    expect(rows[1]).toHaveTextContent('UpdateMonitorpublic-siteintervalSecs, dependsOn')
  })

  it('checks once after a pause, not for every change', async () => {
    postText().mockResolvedValue(result({ create: 1 }, [{ kind: 'Monitor', key: 'a', action: 'create' }]))
    renderPage()
    paste('kind: Monitor')
    paste('kind: Monitor\nkey: a')
    paste(YAML)
    await appears('Apply changes')
    expect(postText()).toHaveBeenCalledTimes(1)
  })

  it('reads a chosen file into the box', async () => {
    postText().mockResolvedValueOnce(result({ create: 1 }, [{ kind: 'Monitor', key: 'public-site', action: 'create' }]))
    const user = renderPage()
    await user.upload(screen.getByLabelText('Configuration file'), new File([YAML], 'site.yaml', { type: 'text/yaml' }))

    await waitFor(() => expect(box()).toHaveValue(YAML))
    await appears('Apply changes')
  })

  it('refuses a file that is too large before sending it', async () => {
    const user = renderPage()
    const big = new File(['x'], 'big.yaml')
    Object.defineProperty(big, 'size', { value: 3 * 1024 * 1024 })
    await user.upload(screen.getByLabelText('Configuration file'), big)

    expect(await screen.findByText(/big\.yaml is larger than 2 MB/)).toBeInTheDocument()
    expect(postText()).not.toHaveBeenCalled()
  })

  it('lists every problem of text it will not apply, and offers no apply', async () => {
    postText().mockRejectedValueOnce(new ApiError('Monitor[x].type: must be one of', 400, undefined, {
      error: 'first',
      problems: [{ path: 'Monitor[x].type', message: 'must be one of https, tcp' }, { path: 'document 2.kind', message: 'is not a kind' }],
    }))
    renderPage()
    paste()

    expect(await screen.findByText('This cannot be applied. Nothing was changed.', {}, { timeout: 2000 })).toBeInTheDocument()
    expect(screen.getByText('Monitor[x].type')).toBeInTheDocument()
    expect(screen.getByText('document 2.kind')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument()
  })

  it('shows the reason when it is not allowed, with no list of problems', async () => {
    postText().mockRejectedValueOnce(new ApiError('You may not import: Monitor (needs the operator role)', 403))
    renderPage()
    paste()
    expect(await screen.findByText('You may not import: Monitor (needs the operator role)', {}, { timeout: 2000 })).toBeInTheDocument()
  })

  it('says when there is nothing to do', async () => {
    postText().mockResolvedValueOnce(result({ unchanged: 2 }, [{ kind: 'Monitor', key: 'a', action: 'unchanged' }]))
    renderPage()
    paste()
    expect(await screen.findByText(/already matches this/, {}, { timeout: 2000 })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument()
  })

  it('applies what was checked, without asking to confirm because nothing is deleted, and empties the box', async () => {
    postText().mockResolvedValueOnce(result({ create: 1 }, [{ kind: 'Monitor', key: 'public-site', action: 'create' }]))
    postText().mockResolvedValueOnce(result({ create: 1 }, [{ kind: 'Monitor', key: 'public-site', action: 'create' }], false))
    const user = renderPage()
    paste()
    await appears('Apply changes')
    await user.click(screen.getByRole('button', { name: 'Apply changes' }))

    expect(await screen.findByText('Applied.')).toBeInTheDocument()
    expect(postText()).toHaveBeenLastCalledWith('/admin/config/apply', YAML, 'application/yaml')
    expect(box()).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument()
  })

  it('keeps the text and shows the problems when applying is refused', async () => {
    postText().mockResolvedValueOnce(result({ create: 1 }, [{ kind: 'Monitor', key: 'public-site', action: 'create' }]))
    postText().mockRejectedValueOnce(new ApiError('conflict', 400, undefined, { error: 'conflict', problems: [{ path: 'Monitor[public-site].dependsOn', message: 'dependency cycle' }] }))
    const user = renderPage()
    paste()
    await appears('Apply changes')
    await user.click(screen.getByRole('button', { name: 'Apply changes' }))

    expect(await screen.findByText('dependency cycle', { exact: false })).toBeInTheDocument()
    expect(box()).toHaveValue(YAML)
  })

  it('clears the box', async () => {
    const user = renderPage()
    paste()
    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(box()).toHaveValue('')
  })
})
