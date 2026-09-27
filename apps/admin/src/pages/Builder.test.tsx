import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LayoutTree } from '@bsp/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { useBuilderStore } from '../components/builder/useBuilderStore'
import BuilderPage from './Builder'

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
  return render(<QueryClientProvider client={queryClient}><BuilderPage /></QueryClientProvider>)
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
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    useBuilderStore.setState({ tree: { id: 'root', type: 'page', children: [] }, selectedId: null, isDirty: false })
    mockApi()
    vi.mocked(api.put).mockResolvedValue({})
  })

  afterEach(() => vi.unstubAllGlobals())

  it('loads the layout, renders every node type and prunes deleted monitors', async () => {
    renderPage()

    expect(await screen.findByText('Core services')).toBeInTheDocument()
    expect(screen.getByText('Welcome to our status page')).toBeInTheDocument()
    expect(screen.getByText('Incydenty · active')).toBeInTheDocument()
    expect(screen.getByText('2d')).toBeInTheDocument()
    expect(screen.getByText('Group note')).toBeInTheDocument()
    // The group child pointing at a deleted monitor is dropped and the page is marked unsaved.
    expect(screen.getByText('Unsaved')).toBeInTheDocument()
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

    await user.click(screen.getByText('Incydenty · active'))
    await user.selectOptions(screen.getByDisplayValue('Active only'), 'resolved')
    expect(await screen.findByText('Incydenty · resolved')).toBeInTheDocument()

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
    expect(screen.getByText('Drag elements from the toolbox')).toBeInTheDocument()
    // The layout is only loaded once monitors exist to prune against.
    expect(api.get).not.toHaveBeenCalledWith('/admin/layout')
  })
})

function findGroupChildren() {
  const group = useBuilderStore.getState().tree.children.find((n) => n.id === 'g1') as { children: Array<{ id: string }> }
  return group.children.map((c) => c.id)
}
