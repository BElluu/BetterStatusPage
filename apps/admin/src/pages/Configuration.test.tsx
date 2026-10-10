import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../api/client'
import ConfigurationPage from './Configuration'

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), postText: vi.fn(), download: vi.fn() } }
})

type Summary = { create: number; update: number; unchanged: number; delete: number }
const result = (summary: Partial<Summary>, changes: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  dryRun: true, prune: false, summary: { create: 0, update: 0, unchanged: 0, delete: 0, ...summary }, changes, ...extra,
})

const YAML = 'version: 1\nmonitors: []\n'
const yamlFile = (name = 'bsp.yaml', text = YAML) => new File([text], name, { type: 'text/yaml' })

function renderPage() {
  render(<ConfigurationPage />)
  return userEvent.setup()
}

const choose = async (user: ReturnType<typeof userEvent.setup>, file = yamlFile()) =>
  user.upload(screen.getByLabelText('Configuration file'), file)

const postText = () => vi.mocked(api.postText)

describe('ConfigurationPage export', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('downloads YAML by default and JSON when asked', async () => {
    vi.mocked(api.download).mockResolvedValue(undefined)
    const user = renderPage()

    await user.click(screen.getByRole('button', { name: /Download/ }))
    expect(api.download).toHaveBeenLastCalledWith('/admin/config/export?format=yaml', 'bsp-config.yaml')

    await user.selectOptions(screen.getByLabelText('Export format'), 'json')
    await user.click(screen.getByRole('button', { name: /Download/ }))
    expect(api.download).toHaveBeenLastCalledWith('/admin/config/export?format=json', 'bsp-config.json')
  })

  it('does not show a secret anywhere on the page, only says how they are written', () => {
    renderPage()
    expect(screen.getAllByText('••••••••').length).toBeGreaterThan(0)
  })
})

describe('ConfigurationPage import', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('checks a chosen file straight away and lists what it would change', async () => {
    postText().mockResolvedValueOnce(result({ create: 1, update: 1, unchanged: 3 }, [
      { kind: 'channel', key: 'pager', action: 'create' },
      { kind: 'monitor', key: 'public-site', action: 'update', fields: ['intervalSecs', 'dependsOn'] },
      { kind: 'monitor', key: 'old', action: 'unchanged' },
    ]))
    const user = renderPage()
    await choose(user)

    expect(await screen.findByText('1 to create · 1 to update · 3 unchanged')).toBeInTheDocument()
    expect(postText()).toHaveBeenCalledWith('/admin/config/validate?prune=false&allowEmpty=false', YAML, 'application/yaml')
    const table = screen.getByRole('table')
    expect(within(table).getByText('Notification channel')).toBeInTheDocument()
    expect(within(table).getByText('public-site')).toBeInTheDocument()
    expect(within(table).getByText('intervalSecs, dependsOn')).toBeInTheDocument()
    expect(within(table).queryByText('old'), 'unchanged rows are not listed').not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply changes' })).toBeEnabled()
    expect(screen.getByText('bsp.yaml')).toBeInTheDocument()
  })

  it('sends a .json file as JSON', async () => {
    postText().mockResolvedValueOnce(result({ unchanged: 1 }))
    const user = renderPage()
    await choose(user, yamlFile('bsp.json', '{"version":1}'))
    await waitFor(() => expect(postText()).toHaveBeenCalledWith(expect.any(String), '{"version":1}', 'application/json'))
  })

  it('says there is nothing to apply when the file already matches', async () => {
    postText().mockResolvedValueOnce(result({ unchanged: 4 }, [{ kind: 'monitor', key: 'a', action: 'unchanged' }]))
    const user = renderPage()
    await choose(user)
    expect(await screen.findByText(/already matches this file/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('lists every problem with its place and offers no way to apply', async () => {
    postText().mockRejectedValueOnce(new ApiError('monitors[a].dependsOn: unknown monitor "x"', 400, undefined, {
      error: 'monitors[a].dependsOn: unknown monitor "x"',
      problems: [
        { path: 'monitors[a].dependsOn', message: 'unknown monitor "x"' },
        { path: 'layout.children[2].monitorKey', message: 'unknown monitor "y"' },
      ],
    }))
    const user = renderPage()
    await choose(user)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('monitors[a].dependsOn')).toBeInTheDocument()
    expect(within(alert).getByText('layout.children[2].monitorKey')).toBeInTheDocument()
    expect(within(alert).getByText(/Nothing was changed/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument()
  })

  it('shows a plain failure, such as a broken YAML file, as a message', async () => {
    postText().mockRejectedValueOnce(new ApiError('Invalid YAML: Flow sequence in block collection must be sufficiently indented at line 2', 400))
    const user = renderPage()
    await choose(user)
    expect(await screen.findByText(/Invalid YAML: Flow sequence/)).toBeInTheDocument()
  })

  it('applies a file without removals right away, and shows what was done', async () => {
    postText()
      .mockResolvedValueOnce(result({ create: 1 }, [{ kind: 'monitor', key: 'new-one', action: 'create' }]))
      .mockResolvedValueOnce(result({ create: 1 }, [{ kind: 'monitor', key: 'new-one', action: 'create' }], { dryRun: false }))
    const user = renderPage()
    await choose(user)
    await user.click(await screen.findByRole('button', { name: 'Apply changes' }))

    expect(postText()).toHaveBeenLastCalledWith('/admin/config/apply?prune=false&allowEmpty=false', YAML, 'application/yaml')
    expect(await screen.findByText('The configuration was applied.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply changes' }), 'the preview is replaced by the result').not.toBeInTheDocument()
    expect(screen.getByText('new-one')).toBeInTheDocument()
  })

  it('asks before an import that removes things, and does nothing if you decline', async () => {
    const removing = result({ delete: 2, unchanged: 1 }, [
      { kind: 'monitor', key: 'gone', action: 'delete' },
      { kind: 'channel', key: 'old-channel', action: 'delete' },
    ], { prune: true })
    postText().mockResolvedValue(removing)
    const user = renderPage()
    await choose(user)
    await user.click(screen.getByRole('switch', { name: /Remove what the file leaves out/ }))
    await screen.findByText('2 to remove · 1 unchanged')
    expect(postText()).toHaveBeenLastCalledWith('/admin/config/validate?prune=true&allowEmpty=false', YAML, 'application/yaml')

    await user.click(screen.getByRole('button', { name: 'Apply changes' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('removes 1 monitor and 1 notification channel that are not in it')
    const callsBefore = postText().mock.calls.length
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(postText().mock.calls.length).toBe(callsBefore)

    postText().mockResolvedValueOnce({ ...removing, dryRun: false })
    await user.click(screen.getByRole('button', { name: 'Apply changes' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Apply and remove' }))
    expect(await screen.findByText('The configuration was applied.')).toBeInTheDocument()
    expect(postText()).toHaveBeenLastCalledWith('/admin/config/apply?prune=true&allowEmpty=false', YAML, 'application/yaml')
  })

  it('only allows an empty section to be pruned once pruning is on, and asks the server again when it changes', async () => {
    postText().mockResolvedValue(result({ unchanged: 1 }))
    const user = renderPage()
    await choose(user)
    await waitFor(() => expect(postText()).toHaveBeenCalledTimes(1))

    const prune = screen.getByRole('switch', { name: /Remove what the file leaves out/ })
    const empty = screen.getByRole('switch', { name: /Allow a section that is empty/ })
    expect(empty).toBeDisabled()

    await user.click(prune)
    expect(empty).toBeEnabled()
    await user.click(empty)
    await waitFor(() => expect(postText()).toHaveBeenLastCalledWith('/admin/config/validate?prune=true&allowEmpty=true', YAML, 'application/yaml'))

    await user.click(prune)
    expect(empty).toBeDisabled()
    expect(empty).toHaveAttribute('aria-checked', 'false')
    await waitFor(() => expect(postText()).toHaveBeenLastCalledWith('/admin/config/validate?prune=false&allowEmpty=false', YAML, 'application/yaml'))
  })

  it('shows only the answer to the latest question when two overlap', async () => {
    let finishFirst: (value: unknown) => void = () => undefined
    postText()
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve }))
      .mockResolvedValueOnce(result({ create: 7 }, [{ kind: 'monitor', key: 'second', action: 'create' }]))
    const user = renderPage()
    await choose(user)
    await user.click(screen.getByRole('switch', { name: /Remove what the file leaves out/ }))
    await screen.findByText('7 to create')

    finishFirst(result({ create: 1 }, [{ kind: 'monitor', key: 'first', action: 'create' }]))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(screen.getByText('7 to create')).toBeInTheDocument()
    expect(screen.queryByText('1 to create')).not.toBeInTheDocument()
  })

  it('does not send a file larger than the server accepts', async () => {
    const user = renderPage()
    const big = yamlFile('big.yaml')
    Object.defineProperty(big, 'size', { value: 3 * 1024 * 1024 })
    await choose(user, big)
    expect(await screen.findByText(/big.yaml is larger than 2 MB/)).toBeInTheDocument()
    expect(postText()).not.toHaveBeenCalled()
  })

  it('lists the problems when the server refuses the file at the last moment', async () => {
    postText()
      .mockResolvedValueOnce(result({ create: 1 }, [{ kind: 'monitor', key: 'x', action: 'create' }]))
      .mockRejectedValueOnce(new ApiError('layout: unknown monitor "x"', 400, undefined, {
        error: 'layout: unknown monitor "x"', problems: [{ path: 'layout', message: 'unknown monitor "x"' }],
      }))
    const user = renderPage()
    await choose(user)
    await user.click(await screen.findByRole('button', { name: 'Apply changes' }))
    expect(await screen.findByText('layout')).toBeInTheDocument()
    expect(screen.queryByText('The configuration was applied.')).not.toBeInTheDocument()
  })
})
