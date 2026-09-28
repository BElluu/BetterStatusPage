import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LayoutTree } from '@bsp/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { useBuilderStore } from '../components/builder/useBuilderStore'
import BuilderPage from './Builder'
import { ToastProvider } from '../components/ui'

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), put: vi.fn() },
}))

const monitors = [
  { id: 1, name: 'Checkout API', type: 'https' },
  { id: 2, name: 'Deploy hook', type: 'webhook' },
]

const layout: LayoutTree = {
  id: 'root',
  type: 'page',
  children: [
    {
      id: 'g1', type: 'group', label: 'Core services', collapsible: false, grid: { x: 0, y: 0, w: 3, h: 3 },
      children: [
        { id: 'gm1', type: 'monitor', monitorId: 1, showUptimeBar: true },
        { id: 'gm-gone', type: 'monitor', monitorId: 99, showUptimeBar: true },
        { id: 'gt1', type: 'text', markdown: 'hi', name: 'Group note' },
      ],
    },
    { id: 'm1', type: 'monitor', monitorId: 1, showUptimeBar: true, grid: { x: 0, y: 5, w: 1, h: 1 } },
    { id: 't1', type: 'text', name: 'Intro', markdown: 'Welcome to our status page', grid: { x: 0, y: 6, w: 3, h: 2 } },
    { id: 'd1', type: 'divider', grid: { x: 0, y: 8, w: 3, h: 1 } },
    { id: 'i1', type: 'incidents', filter: 'active', limit: 5, grid: { x: 0, y: 9, w: 3, h: 1 } },
    { id: 'c1', type: 'chart', monitorId: 1, hours: 48, buckets: 30, aggregation: 'p95', chartH: 7, grid: { x: 0, y: 10, w: 3, h: 1 } },
  ],
} as unknown as LayoutTree

// react-grid-layout measures its container; jsdom has no ResizeObserver.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><ToastProvider><BuilderPage /></ToastProvider></QueryClientProvider>)
}

function mockApi(tree: LayoutTree = layout, monitorList: unknown[] = monitors) {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/monitors') return monitorList
    if (path === '/admin/layout') return tree
    throw new Error(`Unexpected GET ${path}`)
  })
}

function dataTransfer(data: Record<string, string>) {
  return { getData: (key: string) => data[key] ?? '', setData: vi.fn(), dropEffect: '', effectAllowed: '' }
}

describe('BuilderPage', () => {
  // Stubbed for the whole suite: the grid can still observe its container after a test's last assertion.
  beforeAll(() => { vi.stubGlobal('ResizeObserver', NoopResizeObserver) })
  afterAll(() => vi.unstubAllGlobals())

  beforeEach(() => {
    vi.clearAllMocks()
    useBuilderStore.setState({ tree: { id: 'root', type: 'page', children: [] }, selectedId: null, isDirty: false })
    mockApi()
    vi.mocked(api.put).mockResolvedValue({})
  })

  it('loads the layout, renders every node type and prunes deleted monitors', async () => {
    renderPage()

    expect(await screen.findByText('Core services')).toBeInTheDocument()
    expect(screen.getByText('Welcome to our status page')).toBeInTheDocument()
    expect(screen.getByText('Incidents · active')).toBeInTheDocument()
    expect(screen.getByText('2d')).toBeInTheDocument()
    expect(screen.getByText('Group note')).toBeInTheDocument()
    // The group child pointing at a deleted monitor is dropped and the page is marked unsaved.
    expect(await screen.findByText('Unsaved')).toBeInTheDocument()
    expect(findGroupChildren()).toEqual(['gm1', 'gt1'])
    // Only monitors that report response times are offered as charts.
    expect(screen.getByText('Charts').parentElement).not.toHaveTextContent('Deploy hook')
  })

  it('saves the edited layout', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Core services')

    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/layout', { tree: useBuilderStore.getState().tree }))
    expect(await screen.findByText('Saved!')).toBeInTheDocument()
    expect(screen.queryByText('Unsaved')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('reports a failed save and keeps the changes unsaved', async () => {
    const user = userEvent.setup()
    vi.mocked(api.put).mockRejectedValueOnce(new Error('Layout too large'))
    renderPage()
    await screen.findByText('Core services')
    await screen.findByText('Unsaved')

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText("Couldn't save the layout: Layout too large")).toBeInTheDocument()
    expect(screen.getByText('Not saved')).toBeInTheDocument()
    expect(screen.queryByText('Saved!')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('selects cards from the keyboard and adds toolbox blocks without dragging', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Core services')

    const card = screen.getByRole('button', { name: 'Incidents', pressed: false })
    card.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByText('Properties')).toBeInTheDocument()
    expect(card).toHaveAttribute('aria-pressed', 'true')

    const before = useBuilderStore.getState().tree.children.length
    await user.click(screen.getByRole('button', { name: 'Add Divider to the page' }))
    const children = useBuilderStore.getState().tree.children
    expect(children).toHaveLength(before + 1)
    const added = children.at(-1)!
    expect(added.type).toBe('divider')
    // Appended below every existing block.
    expect(added.grid!.y).toBeGreaterThanOrEqual(Math.max(...children.slice(0, -1).map((n) => n.grid!.y)))

    await user.click(screen.getByRole('button', { name: 'Add monitor Deploy hook to the page' }))
    expect(useBuilderStore.getState().tree.children.at(-1)).toMatchObject({ type: 'monitor', monitorId: 2 })
  })

  it('asks before deleting a group that still has items', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Core services')

    await user.click(screen.getByRole('button', { name: 'Delete Group Core services' }))
    expect(screen.getByRole('dialog', { name: 'Delete group' })).toHaveTextContent('Delete "Core services" and the 2 items inside it?')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(findGroupChildren()).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: 'Delete Group Core services' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Delete group' })).getByRole('button', { name: 'Delete' }))
    expect(useBuilderStore.getState().tree.children.find((n) => n.id === 'g1')).toBeUndefined()
  })

  it('edits a monitor card through the properties panel', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Core services')

    await user.click(screen.getAllByText('Checkout API').find((el) => el.closest('.react-grid-item') && !el.closest('.rounded-xl'))!)
    expect(screen.getByText('Properties')).toBeInTheDocument()
    await user.selectOptions(screen.getByDisplayValue('Right'), 'below')
    await user.click(screen.getByLabelText('Show uptime %'))
    await user.click(screen.getByRole('button', { name: 'Compact' }))

    const node = useBuilderStore.getState().tree.children.find((n) => n.id === 'm1')
    expect(node).toMatchObject({ cardVariant: 'compact', uptimeBarPosition: 'below', showUptimePct: true })
    expect(screen.getByText('compact')).toBeInTheDocument()
    await user.click(screen.getByText('Properties').nextElementSibling as HTMLElement)
    expect(screen.queryByText('Properties')).not.toBeInTheDocument()
  })

  it('edits chart, text, incidents and group properties', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Core services')

    await user.click(screen.getByText('2d'))
    await user.click(screen.getByRole('button', { name: 'MAX' }))
    await user.click(screen.getByRole('button', { name: 'S' }))
    await user.selectOptions(screen.getByDisplayValue('Last 2 days'), '168')
    await user.type(screen.getByPlaceholderText('Leave empty to use monitor name'), 'Latency')
    expect(useBuilderStore.getState().tree.children.find((n) => n.id === 'c1')).toMatchObject({ aggregation: 'max', chartH: 3, hours: 168, title: 'Latency' })

    await user.click(screen.getByText('Welcome to our status page'))
    const markdown = screen.getByDisplayValue('Welcome to our status page')
    await user.type(markdown, '{Enter}Line two')
    expect(useBuilderStore.getState().tree.children.find((n) => n.id === 't1')).toMatchObject({ markdown: 'Welcome to our status page\nLine two' })

    await user.click(screen.getByText('Incidents · active'))
    await user.selectOptions(screen.getByLabelText('Filter'), 'resolved')
    expect(await screen.findByText('Incidents · resolved')).toBeInTheDocument()

    await user.click(screen.getByText('Core services'))
    const properties = screen.getByText('Properties').closest('div')!.parentElement!
    await user.click(within(properties).getByRole('button', { name: /Deploy hook/ }))
    expect(findGroupChildren()).toHaveLength(3)
  })

  it('adds a toolbox monitor dropped onto a group and deletes nodes', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Core services')

    // Adding a child remounts the grid, so the drop zone is looked up again for every drop.
    const dropZone = () => screen.getByText(/^(Drag monitor from toolbox|Drop here)$/).parentElement!
    fireEvent.dragOver(dropZone(), { dataTransfer: dataTransfer({}) })
    expect(screen.getByText('Drop here')).toBeInTheDocument()
    fireEvent.drop(dropZone(), { dataTransfer: dataTransfer({ nodeType: 'monitor', monitorId: '2' }) })
    expect(findGroupChildren()).toHaveLength(3)
    fireEvent.drop(dropZone(), { dataTransfer: dataTransfer({ nodeType: 'text' }) })
    expect(findGroupChildren()).toHaveLength(4)
    fireEvent.drop(dropZone(), { dataTransfer: dataTransfer({ nodeType: 'rootMonitor', rootNodeId: 'm1' }) })
    expect(findGroupChildren()).toHaveLength(5)

    const before = useBuilderStore.getState().tree.children.length
    await user.click(screen.getAllByTitle('Delete')[1]!)
    expect(useBuilderStore.getState().tree.children).toHaveLength(before - 1)
  })

  it('shows the empty canvas without layout nodes or monitors', async () => {
    mockApi({ id: 'root', type: 'page', children: [] } as LayoutTree, [])
    renderPage()

    expect(await screen.findByText('No monitors')).toBeInTheDocument()
    expect(await screen.findByText('Drag elements from the toolbox or add them with +')).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledWith('/admin/layout')
  })

  it('loads a saved layout even when there are no monitors', async () => {
    mockApi({
      id: 'root', type: 'page',
      children: [{ id: 't1', type: 'text', name: 'Intro', markdown: 'Hello there', grid: { x: 0, y: 0, w: 3, h: 2 } }],
    } as unknown as LayoutTree, [])
    renderPage()

    expect(await screen.findByText('Hello there')).toBeInTheDocument()
  })

  it('shows an error with retry when the layout cannot be loaded', async () => {
    const user = userEvent.setup()
    let fail = true
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/monitors') return monitors
      if (path === '/admin/layout') {
        if (fail) throw new Error('boom')
        return layout
      }
      throw new Error(`Unexpected GET ${path}`)
    })
    renderPage()

    expect(await screen.findByText("Couldn't load the page layout.")).toBeInTheDocument()
    fail = false
    await user.click(screen.getByRole('button', { name: /Try again/ }))
    expect(await screen.findByText('Core services')).toBeInTheDocument()
  })
})

function findGroupChildren() {
  const group = useBuilderStore.getState().tree.children.find((n) => n.id === 'g1') as { children: Array<{ id: string }> }
  return group.children.map((c) => c.id)
}
