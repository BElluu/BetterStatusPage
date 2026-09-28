import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import ReactGridLayout, { WidthProvider } from 'react-grid-layout/legacy'
import type { Layout, LayoutItem } from 'react-grid-layout/legacy'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { api } from '../api/client'
import { ConfirmModal } from '../components/ConfirmModal'
import { ErrorState, LoadingState, useToast } from '../components/ui'
import {
  useBuilderStore, createMonitorNode, createGroupNode, createTextNode, createIncidentsNode,
  createChartNode, defaultGrid, findNode,
} from '../components/builder/useBuilderStore'
import type {
  Monitor, LayoutTree, LayoutNode, GroupNode, MonitorNode, TextNode, IncidentsNode, ChartNode, GridPos,
} from '@bsp/shared'

// ── Prune monitor nodes that reference deleted monitors ───────────────────────
function pruneOrphanedMonitors(
  tree: LayoutTree,
  validIds: Set<number>,
): { pruned: LayoutTree; removed: number } {
  let removed = 0

  function filterChildren(children: LayoutNode[]): LayoutNode[] {
    const result: LayoutNode[] = []
    for (const node of children) {
      if (node.type === 'monitor') {
        if (validIds.has((node as MonitorNode).monitorId)) {
          result.push(node)
        } else {
          removed++
        }
      } else if (node.type === 'group') {
        const g = node as GroupNode
        result.push({ ...g, children: filterChildren(g.children) })
      } else {
        result.push(node)
      }
    }
    return result
  }

  const pruned = { ...tree, children: filterChildren(tree.children) }
  return { pruned, removed }
}

// ── react-grid-layout setup ───────────────────────────────────────────────────
const RGL = WidthProvider(ReactGridLayout)
const ROW_H = 44
const COLS = 3

function calcTextH(markdown: string): number {
  const lines = markdown.split('\n').length
  const estimatedPx = lines * 22 + 28   // ~22px per line + padding
  return Math.max(1, Math.ceil(estimatedPx / ROW_H))
}

const CHART_TYPES = ['https', 'ping', 'sqlserver']

/** A new root node of the given toolbox type, or null when the type needs a monitor that was not given. */
function createToolboxNode(type: string, options: { monitorId?: number; label?: string } = {}): Omit<LayoutNode, 'id'> | null {
  switch (type) {
    case 'monitor':   return options.monitorId ? createMonitorNode(options.monitorId) : null
    case 'group':     return createGroupNode(options.label || 'New group')
    case 'text':      return createTextNode()
    case 'divider':   return { type: 'divider' } as Omit<LayoutNode, 'id'>
    case 'incidents': return createIncidentsNode()
    case 'chart':     return options.monitorId ? createChartNode(options.monitorId) : null
    default:          return null
  }
}

/** Human name of a node, used for accessible labels on cards and their delete buttons. */
function nodeLabel(node: LayoutNode, monitors: Monitor[]): string {
  const monitorName = (id: number) => monitors.find((m) => m.id === id)?.name ?? `#${id}`
  switch (node.type) {
    case 'group':     return `Group ${(node as GroupNode).label || 'Group'}`
    case 'monitor':   return `Monitor ${monitorName((node as MonitorNode).monitorId)}`
    case 'chart':     return `Chart ${monitorName((node as ChartNode).monitorId)}`
    case 'text':      return `Text ${(node as TextNode).name || ''}`.trim()
    case 'incidents': return 'Incidents'
    case 'divider':   return 'Divider'
    default:          return 'Block'
  }
}

/** Makes a card focusable and selectable with Enter/Space, without reacting to keys aimed at its inner buttons. */
function selectableCard(onSelect: () => void, isSelected: boolean, label: string) {
  return {
    role: 'button',
    tabIndex: 0,
    'aria-pressed': isSelected,
    'aria-label': label,
    onClick: onSelect,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onSelect()
      }
    },
  }
}

// ── Builder page ──────────────────────────────────────────────────────────────
export default function BuilderPage() {
  const toast = useToast()
  const {
    tree, setTree, isDirty, markClean,
    addNode, updateNode, deleteNode,
    applyGridLayout, reorderGroupChildren,
    moveToGroup, insertRootNode,
    selectNode, selectedId,
  } = useBuilderStore()

  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<GroupNode | null>(null)
  const [layoutStatus, setLayoutStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [layoutAttempt, setLayoutAttempt] = useState(0)
  const prunedRef = useRef(false)

  // What's currently being dragged from toolbox (for droppingItem size hint)
  const draggingTypeRef = useRef<string>('monitor')
  const [droppingItem, setDroppingItem] = useState<LayoutItem>({
    i: '__dropping__', x: 0, y: 0, w: 1, h: 1,
  })

  const monitorsQuery = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
  })
  const monitors = useMemo(() => monitorsQuery.data ?? [], [monitorsQuery.data])

  // The layout loads on its own, so a page without monitors (or with a slow monitor list) still opens.
  useEffect(() => {
    let cancelled = false
    api.get<LayoutTree>('/admin/layout').then(
      (loaded) => {
        if (cancelled) return
        setTree(loaded)
        setLayoutStatus('ready')
      },
      () => { if (!cancelled) setLayoutStatus('error') },
    )
    return () => { cancelled = true }
  }, [setTree, layoutAttempt])

  // Once both the layout and the monitor list are in, drop nodes that point at deleted monitors — once.
  useEffect(() => {
    if (prunedRef.current || layoutStatus !== 'ready' || !monitorsQuery.isSuccess) return
    prunedRef.current = true
    const validIds = new Set(monitorsQuery.data.map((m) => m.id))
    const { pruned, removed } = pruneOrphanedMonitors(useBuilderStore.getState().tree, validIds)
    // Mark dirty so the cleaned-up layout can be saved.
    if (removed > 0) useBuilderStore.setState({ tree: pruned, isDirty: true })
  }, [layoutStatus, monitorsQuery.isSuccess, monitorsQuery.data])

  function retryLayout() {
    setLayoutStatus('loading')
    setLayoutAttempt((n) => n + 1)
  }

  async function handleSave() {
    setSaving(true)
    setSaveError('')
    try {
      await api.put('/admin/layout', { tree })
      markClean()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'Unknown error'
      setSaveError(message)
      toast.error(`Couldn't save the layout: ${message}`)
    } finally {
      setSaving(false)
    }
  }

  /** Groups that still hold items ask before they are removed together with their contents. */
  function requestDelete(node: LayoutNode) {
    if (node.type === 'group' && (node as GroupNode).children.length > 0) setConfirmDeleteGroup(node as GroupNode)
    else deleteNode(node.id)
  }

  // Layout array for RGL (derived from tree)
  // Group height is computed dynamically from children count; all items lock height (width-only resize)
  const rglLayout: LayoutItem[] = useMemo(() =>
    tree.children.map((node, i) => {
      const g = node.grid ?? { ...defaultGrid(node.type), y: i * 3 }
      const h = node.type === 'group'
        ? 2 + (node as GroupNode).children.length   // header row + 1 per child
        : (node.type === 'monitor' || node.type === 'incidents' || node.type === 'divider' || node.type === 'chart')
        ? 1                                          // always compact — ignore stored h
        : g.h                                        // text: auto-sized from content
      return { i: node.id, x: g.x, y: g.y, w: g.w, h, minH: h, maxH: h, minW: 1, maxW: 3 }
    }),
    [tree.children],
  )

  // Ensure the canvas is always tall enough to drop below the last item
  const canvasMinHeight = useMemo(() => {
    const maxBottom = rglLayout.reduce((max, item) => Math.max(max, item.y + item.h), 0)
    return (maxBottom + 4) * (ROW_H + 10)
  }, [rglLayout])

  // Force RGL remount when items are added/removed or group child counts change
  const rglKey = useMemo(() =>
    tree.children.length + '|' +
    tree.children
      .filter((n) => n.type === 'group')
      .map((n) => `${n.id}:${(n as GroupNode).children.length}`)
      .join('|'),
    [tree.children],
  )

  function handleLayoutChange(newLayout: Layout) {
    applyGridLayout(newLayout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })))
  }

  // Drop from toolbox
  function handleToolboxDragStart(type: string, data?: Record<string, string>) {
    draggingTypeRef.current = type
    const g = defaultGrid(type)
    setDroppingItem({ i: '__dropping__', x: 0, y: 0, w: g.w, h: g.h })
    return data ?? {}
  }

  function handleDrop(_layout: Layout, item: LayoutItem | undefined, e: Event) {
    const de = e as DragEvent
    const type = de.dataTransfer?.getData('nodeType') ?? ''
    const dropY = item?.y ?? 0
    const grid: GridPos = { x: item?.x ?? 0, y: dropY, w: item?.w ?? 1, h: item?.h ?? 1 }
    const node = createToolboxNode(type, {
      monitorId: Number(de.dataTransfer?.getData('monitorId')) || 0,
      label: de.dataTransfer?.getData('label') ?? '',
    })
    if (node) insertRootNode({ ...node, grid } as Omit<LayoutNode, 'id'>, dropY)
  }

  /** Keyboard/click alternative to dragging: appends the block below everything on the page. */
  function handleToolboxAdd(type: string, monitorId?: number) {
    const node = createToolboxNode(type, monitorId ? { monitorId } : {})
    if (!node) return
    const bottom = rglLayout.reduce((max, item) => Math.max(max, item.y + item.h), 0)
    insertRootNode({ ...node, grid: { ...defaultGrid(type), x: 0, y: bottom } } as Omit<LayoutNode, 'id'>, bottom)
  }

  const selectedNode = selectedId ? findNode(tree.children, selectedId) : null

  // @dnd-kit sensors for within-group reordering
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  function handleGroupDragEnd(groupId: string) {
    return ({ active, over }: DragEndEvent) => {
      if (over && active.id !== over.id) {
        reorderGroupChildren(groupId, active.id as string, over.id as string)
      }
    }
  }

  return (
    <div className="flex h-full overflow-hidden"  style={{ '--rgl-placeholder-bg': 'color-mix(in srgb, var(--m3-primary) 15%, transparent)' } as React.CSSProperties}>
      {/* ── Toolbox + Properties ── */}
      <aside className="w-56 flex flex-col shrink-0 overflow-y-auto" style={{ background: "var(--m3-surface-container-low)", borderRight: "1px solid var(--m3-outline-variant)" }}>
        <div className="p-3" style={{ borderBottom: "1px solid var(--m3-outline-variant)" }}>
          <h2 className="text-xs font-semibold" style={{ color: 'var(--m3-on-surface)' }}>Toolbox</h2>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--m3-secondary)' }}>Drag onto canvas or press + to add</p>
        </div>

        <div className="p-3 space-y-4">
          {/* Groups */}
          <section>
            <p className="text-[10px] uppercase tracking-wider text-secondary mb-1.5">Groups</p>
            <ToolboxItem
              label="New group"
              onAdd={() => handleToolboxAdd('group')}
              onDragStart={(e) => {
                handleToolboxDragStart('group', { label: 'New group' })
                e.dataTransfer.setData('nodeType', 'group')
                e.dataTransfer.setData('label', 'New group')
                e.dataTransfer.effectAllowed = 'copy'
              }}
            >
              <span className="text-secondary" aria-hidden="true">◧</span>
              <span className="truncate">New group</span>
            </ToolboxItem>
          </section>

          {/* Monitors */}
          <section>
            <p className="text-[10px] uppercase tracking-wider text-secondary mb-1.5">Monitors</p>
            <div className="space-y-1">
              {monitors.map((m) => (
                <ToolboxItem
                  key={m.id}
                  label={`monitor ${m.name}`}
                  onAdd={() => handleToolboxAdd('monitor', m.id)}
                  onDragStart={(e) => {
                    handleToolboxDragStart('monitor')
                    e.dataTransfer.setData('nodeType', 'monitor')
                    e.dataTransfer.setData('monitorId', String(m.id))
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                >
                  <span className="text-[9px] uppercase bg-surface-container-high text-secondary px-1 rounded shrink-0">{m.type}</span>
                  <span className="truncate">{m.name}</span>
                </ToolboxItem>
              ))}
              {monitorsQuery.isPending && <p className="text-xs text-secondary">Loading monitors…</p>}
              {monitorsQuery.isError && <p className="text-xs" style={{ color: 'var(--m3-down)' }}>Couldn't load monitors</p>}
              {monitorsQuery.isSuccess && monitors.length === 0 && <p className="text-xs text-secondary">No monitors</p>}
            </div>
          </section>

          {/* Blocks */}
          <section>
            <p className="text-[10px] uppercase tracking-wider text-secondary mb-1.5">Blocks</p>
            <div className="space-y-1">
              {[
                { type: 'text',      label: 'Text',      icon: 'T'  },
                { type: 'divider',   label: 'Divider',   icon: '—'  },
                { type: 'incidents', label: 'Incidents', icon: '⚠'  },
              ].map(({ type, label, icon }) => (
                <ToolboxItem
                  key={type}
                  label={label}
                  onAdd={() => handleToolboxAdd(type)}
                  onDragStart={(e) => {
                    handleToolboxDragStart(type)
                    e.dataTransfer.setData('nodeType', type)
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                >
                  <span className="text-secondary font-mono text-xs" aria-hidden="true">{icon}</span>
                  {label}
                </ToolboxItem>
              ))}
            </div>
          </section>

          {/* Charts */}
          {monitors.some((m) => CHART_TYPES.includes(m.type)) && (
            <section>
              <p className="text-[10px] uppercase tracking-wider text-secondary mb-1.5">Charts</p>
              <div className="space-y-1">
                {monitors.filter((m) => CHART_TYPES.includes(m.type)).map((m) => (
                  <ToolboxItem
                    key={m.id}
                    label={`chart for ${m.name}`}
                    onAdd={() => handleToolboxAdd('chart', m.id)}
                    onDragStart={(e) => {
                      handleToolboxDragStart('chart')
                      e.dataTransfer.setData('nodeType', 'chart')
                      e.dataTransfer.setData('monitorId', String(m.id))
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                  >
                    <span className="text-secondary font-mono text-xs" aria-hidden="true">↗</span>
                    <span className="text-[9px] uppercase bg-surface-container-high text-secondary px-1 rounded shrink-0">{m.type}</span>
                    <span className="truncate">{m.name}</span>
                  </ToolboxItem>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* ── Properties (below toolbox, when element selected) ── */}
        {selectedNode && (
          <div className="flex flex-col" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
            <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
              <p className="text-[10px] uppercase tracking-wider text-secondary font-semibold">Properties</p>
              <button type="button" onClick={() => selectNode(null)} aria-label="Close properties" title="Close properties" className="btn-icon w-6 h-6 text-base leading-none">×</button>
            </div>
            <div className="p-3">
              <PropertiesPanel
                node={selectedNode}
                monitors={monitors}
                onUpdate={(patch) => updateNode(selectedNode.id, patch)}
                onAddChild={(n) => addNode(selectedNode.id, n)}
              />
            </div>
          </div>
        )}
      </aside>

      {/* ── Canvas ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 shrink-0" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
          <div>
            <h1 className="font-headline text-base font-bold" style={{ color: 'var(--m3-on-surface)' }}>Page Builder</h1>
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--m3-secondary)' }}>Drag from toolbox · Resize horizontally (1–3 col) · Click to edit</p>
          </div>
          <div className="flex items-center gap-3" aria-live="polite">
            {isDirty && !saveError && <span className="text-xs" style={{ color: 'var(--m3-degraded)' }}>Unsaved</span>}
            {saveError && (
              <span role="alert" className="flex items-center gap-1 text-xs" style={{ color: 'var(--m3-down)' }} title={saveError}>
                <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '14px' }}>error</span>
                Not saved
              </span>
            )}
            {saved && (
              <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--m3-up)' }}>
                <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '14px' }}>check_circle</span>
                Saved!
              </span>
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !isDirty}
              className="btn btn-primary btn-sm"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4" style={{ background: 'var(--m3-surface-container-low)' }}>
          {layoutStatus === 'loading' ? (
            <LoadingState label="Loading layout…" />
          ) : layoutStatus === 'error' ? (
            <ErrorState message="Couldn't load the page layout." onRetry={retryLayout} />
          ) : tree.children.length === 0 ? (
            <EmptyDrop onDrop={handleDrop} droppingItem={droppingItem} rglLayout={rglLayout} />
          ) : (
            <div className="relative">
              {/* Column guides */}
              <div className="absolute inset-0 pointer-events-none" style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '10px',
                padding: '0',
              }}>
                {[0, 1, 2].map((i) => (
                  <div key={i} style={{
                    borderLeft: i === 0 ? 'none' : '1px dashed var(--m3-outline-variant)',
                  }} />
                ))}
              </div>
            <RGL
              key={rglKey}
              layout={rglLayout}
              cols={COLS}
              rowHeight={ROW_H}
              margin={[10, 10]}
              containerPadding={[0, 0]}
              draggableHandle=".drag-handle"
              isDroppable
              isResizable
              resizeHandles={['e']}
              droppingItem={droppingItem}
              onDrop={handleDrop}
              onLayoutChange={handleLayoutChange}
              useCSSTransforms
              style={{ minHeight: canvasMinHeight }}
            >
              {tree.children.map((node) => (
                <div key={node.id}>
                  <NodeCard
                    node={node}
                    monitors={monitors}
                    isSelected={selectedId === node.id}
                    onSelect={() => selectNode(selectedId === node.id ? null : node.id)}
                    onSelectChild={(id) => selectNode(selectedId === id ? null : id)}
                    onDelete={() => requestDelete(node)}
                    onUpdate={(patch) => updateNode(node.id, patch)}
                    onAddChild={(n) => addNode(node.id, n)}
                    onMoveToGroup={(nodeId, groupId) => moveToGroup(nodeId, groupId)}
                    sensors={sensors}
                    onGroupDragEnd={handleGroupDragEnd(node.id)}
                  />
                </div>
              ))}
            </RGL>
            </div>
          )}
        </div>
      </div>

      {confirmDeleteGroup && (
        <ConfirmModal
          title="Delete group"
          message={`Delete "${confirmDeleteGroup.label || 'Group'}" and the ${confirmDeleteGroup.children.length} ${confirmDeleteGroup.children.length === 1 ? 'item' : 'items'} inside it?`}
          onConfirm={() => { deleteNode(confirmDeleteGroup.id); setConfirmDeleteGroup(null) }}
          onCancel={() => setConfirmDeleteGroup(null)}
        />
      )}
    </div>
  )
}

// ── Toolbox entry: draggable onto the canvas, or added at the bottom with its + button ──
function ToolboxItem({ label, onAdd, onDragStart, children }: {
  label: string
  onAdd: () => void
  onDragStart: (e: React.DragEvent) => void
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center rounded bg-surface-container hover:bg-surface-container-high">
      <div
        draggable
        onDragStart={onDragStart}
        className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-sm text-on-surface-variant cursor-grab active:cursor-grabbing select-none"
      >
        {children}
      </div>
      <button type="button" onClick={onAdd} aria-label={`Add ${label} to the page`} title="Add to page" className="btn-icon w-7 h-7 mr-0.5">
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px' }}>add</span>
      </button>
    </div>
  )
}

// ── Empty canvas with drop support ────────────────────────────────────────────
function EmptyDrop({ onDrop, droppingItem, rglLayout }: {
  onDrop: (layout: Layout, item: LayoutItem | undefined, e: Event) => void
  droppingItem: LayoutItem
  rglLayout: LayoutItem[]
}) {
  return (
    <div className="min-h-64">
      <RGL
        layout={rglLayout}
        cols={COLS}
        rowHeight={ROW_H}
        margin={[10, 10]}
        containerPadding={[0, 0]}
        draggableHandle=".drag-handle"
        isDroppable
        droppingItem={droppingItem}
        onDrop={onDrop}
        isResizable
        resizeHandles={['e']}
        onLayoutChange={() => {}}
        style={{ minHeight: 260 }}
      >{null}</RGL>
      <div className="flex items-center justify-center h-48 border-2 border-dashed rounded-xl text-secondary -mt-10 pointer-events-none">
        <p className="text-sm">Drag elements from the toolbox or add them with +</p>
      </div>

    </div>
  )
}

// ── Node card ─────────────────────────────────────────────────────────────────
interface NodeCardProps {
  node: LayoutNode
  monitors: Monitor[]
  isSelected: boolean
  onSelect: () => void
  onSelectChild: (id: string) => void
  onDelete: () => void
  onUpdate: (patch: Partial<LayoutNode>) => void
  onAddChild: (n: Omit<LayoutNode, 'id'>) => void
  onMoveToGroup: (nodeId: string, groupId: string) => void
  sensors: ReturnType<typeof useSensors>
  onGroupDragEnd: (e: DragEndEvent) => void
}

function DeleteBtn({ onDelete, label }: { onDelete: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onDelete() }}
      className="absolute top-1 right-1 z-10 w-5 h-5 flex items-center justify-center rounded text-secondary hover:bg-[var(--m3-down-bg)] hover:text-[var(--m3-down)] focus-ring transition-colors text-xs leading-none"
      title="Delete"
      aria-label={`Delete ${label}`}
    >
      ×
    </button>
  )
}

function NodeCard(props: NodeCardProps) {
  const { node, isSelected, onSelect, onSelectChild, onDelete, onMoveToGroup } = props
  const ring = isSelected ? 'ring-2 ring-primary' : 'ring-1 ring-outline-variant'
  const label = nodeLabel(node, props.monitors)
  const card = selectableCard(onSelect, isSelected, label)

  if (node.type === 'divider') {
    return (
      <div className={`relative h-full flex items-center rounded-lg bg-surface-container-low overflow-hidden focus-ring ${ring}`} {...card}>
        <span className="drag-handle cursor-grab px-2 text-secondary hover:text-on-surface-variant self-stretch flex items-center" aria-hidden="true">⠿</span>
        <hr className="flex-1 border-outline-variant mr-6" />
        <DeleteBtn onDelete={onDelete} label={label} />
      </div>
    )
  }

  if (node.type === 'text') {
    const n = node as TextNode
    return (
      <div className={`relative h-full flex flex-col rounded-lg bg-surface-container-low overflow-hidden focus-ring ${ring}`} {...card}>
        <DeleteBtn onDelete={onDelete} label={label} />
        <div className="flex items-center gap-1 px-2 py-1.5 shrink-0 pr-7 border-b border-outline-variant/40">
          <span className="drag-handle cursor-grab text-secondary hover:text-on-surface-variant" aria-hidden="true">⠿</span>
          <span className="text-[10px] text-secondary uppercase tracking-wider">Text</span>
          <span className="text-xs text-on-surface-variant truncate ml-1">{n.name || ''}</span>
        </div>
        <div className="flex-1 px-3 py-2 overflow-auto">
          <p className="text-xs text-on-surface-variant whitespace-pre-wrap">{n.markdown}</p>
        </div>
      </div>
    )
  }

  if (node.type === 'monitor') {
    const n = node as MonitorNode
    const monitor = props.monitors.find((m) => m.id === n.monitorId)
    return (
      <div className={`relative h-full flex items-center gap-2 px-3 rounded-lg bg-surface-container-low focus-ring ${ring}`} {...card}>
        <DeleteBtn onDelete={onDelete} label={label} />
        <span className="drag-handle cursor-grab text-secondary hover:text-on-surface-variant shrink-0" aria-hidden="true">⠿</span>
        <span className="text-[9px] uppercase bg-surface-container-high text-on-surface-variant px-1 py-0.5 rounded shrink-0">{monitor?.type ?? '?'}</span>
        <span className="flex-1 text-sm text-on-surface truncate pr-5">{monitor?.name ?? `#${n.monitorId}`}</span>
        {(n.cardVariant === 'compact') && (
          <span className="text-[9px] uppercase bg-surface-container text-secondary px-1 py-0.5 rounded shrink-0">compact</span>
        )}
      </div>
    )
  }

  if (node.type === 'incidents') {
    const n = node as IncidentsNode
    const filterLabel = n.filter === 'active' ? 'active' : n.filter === 'resolved' ? 'resolved' : 'all'
    return (
      <div className={`relative h-full flex items-center gap-2 px-3 rounded-lg bg-surface-container-low focus-ring ${ring}`} {...card}>
        <DeleteBtn onDelete={onDelete} label={label} />
        <span className="drag-handle cursor-grab text-secondary hover:text-on-surface-variant shrink-0" aria-hidden="true">⠿</span>
        <span className="material-symbols-outlined text-secondary shrink-0" aria-hidden="true" style={{ fontSize: '16px' }}>warning</span>
        <span className="flex-1 text-sm text-on-surface truncate pr-5">Incidents · {filterLabel}</span>
      </div>
    )
  }

  if (node.type === 'chart') {
    const n = node as ChartNode
    const monitor = props.monitors.find((m) => m.id === n.monitorId)
    const rangeLabel = n.hours < 24 ? `${n.hours}h` : n.hours === 24 ? '24h' : n.hours === 48 ? '2d' : '7d'
    const sizeLabel = n.chartH === 3 ? 'S' : n.chartH === 7 ? 'L' : 'M'
    return (
      <div className={`relative h-full flex items-center gap-2 px-3 rounded-lg bg-surface-container-low focus-ring ${ring}`} {...card}>
        <DeleteBtn onDelete={onDelete} label={label} />
        <span className="drag-handle cursor-grab text-secondary hover:text-on-surface-variant shrink-0" aria-hidden="true">⠿</span>
        <span className="text-secondary font-mono text-xs shrink-0" aria-hidden="true">↗</span>
        <span className="flex-1 text-sm text-on-surface truncate pr-5">{monitor?.name ?? `#${n.monitorId}`}</span>
        <span className="text-[9px] uppercase bg-surface-container text-secondary px-1 py-0.5 rounded shrink-0">{sizeLabel}</span>
        <span className="text-[9px] uppercase bg-surface-container text-secondary px-1 py-0.5 rounded shrink-0">{n.aggregation}</span>
        <span className="text-[9px] uppercase bg-surface-container text-secondary px-1 py-0.5 rounded shrink-0">{rangeLabel}</span>
      </div>
    )
  }

  if (node.type === 'group') {
    return <GroupCard {...props} node={node as GroupNode} onSelectChild={onSelectChild} onMoveToGroup={onMoveToGroup} />
  }

  return null
}

// ── Group card (with inner @dnd-kit sortable) ─────────────────────────────────
function GroupCard({
  node, monitors, isSelected, onSelect, onSelectChild, onDelete, onUpdate, onAddChild,
  onMoveToGroup,
  sensors, onGroupDragEnd,
}: Omit<NodeCardProps, 'node'> & { node: GroupNode }) {
  const { selectedId } = useBuilderStore()
  const ring = isSelected ? 'ring-2 ring-primary' : 'ring-1 ring-outline-variant'
  const [isDragOver, setIsDragOver] = useState(false)

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setIsDragOver(true)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    const type = e.dataTransfer.getData('nodeType')
    if (type === 'rootMonitor') {
      // Move existing root-level monitor into this group
      const nodeId = e.dataTransfer.getData('rootNodeId')
      if (nodeId) onMoveToGroup(nodeId, node.id)
    } else if (type === 'monitor') {
      const monitorId = Number(e.dataTransfer.getData('monitorId'))
      if (monitorId) onAddChild(createMonitorNode(monitorId))
    } else if (type === 'text') {
      onAddChild(createTextNode())
    }
  }

  return (
    <div className={`relative h-full flex flex-col rounded-xl bg-surface-container-low overflow-hidden focus-ring ${ring}`} {...selectableCard(onSelect, isSelected, nodeLabel(node, monitors))}>
      <DeleteBtn onDelete={onDelete} label={nodeLabel(node, monitors)} />
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 pr-7">
        <span className="drag-handle cursor-grab text-secondary hover:text-on-surface-variant" aria-hidden="true">⠿</span>
        <span className="text-on-surface-variant text-sm" aria-hidden="true">◧</span>
        <span className="flex-1 text-sm font-medium text-on-surface truncate">{node.label || 'Group'}</span>
        <span className="text-[10px] text-secondary">{node.children.length}</span>
      </div>

      {/* Children (sortable + drop target) */}
      <div
        className={`flex-1 overflow-y-auto p-2 transition-colors ${isDragOver ? 'bg-primary/10' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onDragOver={handleDragOver}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
      >
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onGroupDragEnd}>
          <SortableContext items={node.children.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-1.5">
              {node.children.map((child) => (
                <SortableGroupItem
                  key={child.id}
                  child={child}
                  monitors={monitors}
                  onSelect={() => onSelectChild(child.id)}
                  isSelected={selectedId === child.id}
                  onDelete={() => {
                    const updated = { ...node, children: node.children.filter((c) => c.id !== child.id) }
                    onUpdate(updated as Partial<LayoutNode>)
                  }}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        <div className={`mt-1.5 border-2 border-dashed rounded-lg py-2 text-center text-[10px] transition-colors ${
          isDragOver ? 'border-primary text-primary' : 'border-outline-variant text-secondary'
        }`}>
          {isDragOver ? 'Drop here' : 'Drag monitor from toolbox'}
        </div>
      </div>
    </div>
  )
}

function SortableGroupItem({
  child, monitors, onSelect, isSelected, onDelete,
}: { child: LayoutNode; monitors: Monitor[]; onSelect: () => void; isSelected: boolean; onDelete: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: child.id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  const monitor = child.type === 'monitor'
    ? monitors.find((m) => m.id === (child as MonitorNode).monitorId)
    : null
  const childName = nodeLabel(child, monitors)

  return (
    <div
      ref={setNodeRef}
      style={{
        ...style,
        background: isSelected ? 'color-mix(in srgb, var(--m3-primary) 15%, transparent)' : 'var(--m3-surface-container)',
        outline: isSelected ? '1px solid color-mix(in srgb, var(--m3-primary) 50%, transparent)' : 'none',
      }}
      className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm cursor-pointer focus-ring"
      {...selectableCard(onSelect, isSelected, childName)}
    >
      <span
        {...attributes}
        {...listeners}
        role="button"
        aria-label={`Reorder ${childName}`}
        className="cursor-grab text-secondary hover:text-on-surface-variant touch-none rounded focus-ring"
        onClick={(e) => e.stopPropagation()}
      >
        ⠿
      </span>
      {monitor ? (
        <>
          <span className="text-[9px] uppercase bg-surface-container-high text-secondary px-1 rounded">{monitor.type}</span>
          <span className="flex-1 text-on-surface-variant truncate">{monitor.name}</span>
        </>
      ) : child.type === 'text' ? (
        <>
          <span className="text-[9px] uppercase bg-surface-container-high text-secondary px-1 rounded">T</span>
          <span className="flex-1 text-on-surface-variant truncate">{(child as TextNode).name || 'Text'}</span>
        </>
      ) : (
        <span className="flex-1 text-on-surface-variant truncate">{child.id}</span>
      )}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        aria-label={`Remove ${childName} from group`}
        title="Remove from group"
        className="text-secondary hover:text-status-down text-xs leading-none shrink-0 rounded focus-ring"
      >
        ×
      </button>
    </div>
  )
}

// ── Properties panel ──────────────────────────────────────────────────────────
function PropertiesPanel({
  node, monitors, onUpdate, onAddChild,
}: {
  node: LayoutNode
  monitors: Monitor[]
  onUpdate: (patch: Partial<LayoutNode>) => void
  onAddChild: (n: Omit<LayoutNode, 'id'>) => void
}) {
  const cls = 'input-m3 text-xs'

  if (node.type === 'text') {
    const n = node as TextNode
    return (
      <div className="space-y-3">
        <Label htmlFor="builder-prop-name">Name</Label>
        <input
          id="builder-prop-name"
          value={n.name ?? ''}
          onChange={(e) => onUpdate({ name: e.target.value } as Partial<TextNode>)}
          className={cls}
          placeholder="New text"
        />
        <Label htmlFor="builder-prop-markdown">Text (Markdown)</Label>
        <textarea
          id="builder-prop-markdown"
          value={n.markdown}
          onChange={(e) => {
            const markdown = e.target.value
            const h = calcTextH(markdown)
            onUpdate({ markdown, grid: n.grid ? { ...n.grid, h } : undefined } as Partial<TextNode>)
          }}
          rows={12}
          className={`${cls} resize-none font-mono`}
        />
      </div>
    )
  }

  if (node.type === 'monitor') {
    const n = node as MonitorNode
    return (
      <div className="space-y-3">
        <Label htmlFor="builder-prop-monitor">Monitor</Label>
        <select id="builder-prop-monitor" value={n.monitorId} onChange={(e) => onUpdate({ monitorId: Number(e.target.value) } as Partial<MonitorNode>)} className={cls}>
          {monitors.map((m) => <option key={m.id} value={m.id}>[{m.type.toUpperCase()}] {m.name}</option>)}
        </select>

        <div role="group" aria-labelledby="builder-prop-card-type">
          <Label id="builder-prop-card-type">Card type</Label>
          <div className="flex gap-1 mt-1">
            {(['default', 'compact'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={(n.cardVariant ?? 'default') === v}
                onClick={() => onUpdate({ cardVariant: v } as Partial<MonitorNode>)}
                className="flex-1 text-xs py-1.5 rounded transition-all focus-ring"
                style={
                  (n.cardVariant ?? 'default') === v
                    ? { background: 'var(--admin-selection)', color: 'var(--admin-on-selection)' }
                    : { background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)' }
                }
              >
                {v === 'default' ? 'Full' : 'Compact'}
              </button>
            ))}
          </div>
        </div>

        {(n.cardVariant ?? 'default') === 'default' && (
          <>
            <Toggle label="Uptime bar" checked={n.showUptimeBar}
              onChange={(v) => onUpdate({ showUptimeBar: v } as Partial<MonitorNode>)} />
            {n.showUptimeBar && (
              <div>
                <Label htmlFor="builder-prop-uptime-position">Uptime bar position</Label>
                <select
                  id="builder-prop-uptime-position"
                  value={n.uptimeBarPosition ?? 'right'}
                  onChange={(e) => onUpdate({ uptimeBarPosition: e.target.value as 'right' | 'below' } as Partial<MonitorNode>)}
                  className={cls}
                >
                  <option value="right">Right</option>
                  <option value="below">Below</option>
                </select>
              </div>
            )}
            {n.showUptimeBar && (n.uptimeBarPosition ?? 'right') === 'below' && (
              <Toggle label="Show uptime %" checked={n.showUptimePct ?? false}
                onChange={(v) => onUpdate({ showUptimePct: v } as Partial<MonitorNode>)} />
            )}
          </>
        )}

        <Toggle label="Show monitor type" checked={n.showMonitorType ?? false}
          onChange={(v) => onUpdate({ showMonitorType: v } as Partial<MonitorNode>)} />
      </div>
    )
  }

  if (node.type === 'group') {
    const n = node as GroupNode
    return (
      <div className="space-y-3">
        <Label htmlFor="builder-prop-group-name">Group name</Label>
        <input id="builder-prop-group-name" value={n.label} onChange={(e) => onUpdate({ label: e.target.value } as Partial<GroupNode>)} className={cls} />
        <Toggle label="Collapsible" checked={n.collapsible}
          onChange={(v) => onUpdate({ collapsible: v } as Partial<GroupNode>)} />
        <div className="border-t pt-3">
          <Label>Add monitor to group</Label>
          <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
            {monitors.map((m) => (
              <button key={m.id} type="button" onClick={() => onAddChild(createMonitorNode(m.id))}
                className="w-full text-left text-xs text-on-surface-variant hover:text-on-surface px-2 py-1.5 rounded hover:bg-surface-container-high flex items-center gap-2 focus-ring">
                <span className="text-[9px] uppercase text-secondary">{m.type}</span>
                {m.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (node.type === 'incidents') {
    const n = node as IncidentsNode
    return (
      <div className="space-y-3">
        <Label htmlFor="builder-prop-limit">Incident limit</Label>
        <input
          id="builder-prop-limit"
          type="number"
          min={1}
          max={20}
          value={n.limit ?? 5}
          onChange={(e) => onUpdate({ limit: Number(e.target.value) } as Partial<IncidentsNode>)}
          className={cls}
        />
        <Label htmlFor="builder-prop-filter">Filter</Label>
        <select
          id="builder-prop-filter"
          value={n.filter ?? 'all'}
          onChange={(e) => onUpdate({ filter: e.target.value as IncidentsNode['filter'] } as Partial<IncidentsNode>)}
          className={cls}
        >
          <option value="all">All</option>
          <option value="active">Active only</option>
          <option value="resolved">Resolved only</option>
        </select>
      </div>
    )
  }

  if (node.type === 'chart') {
    const n = node as ChartNode
    const compatibleMonitors = monitors.filter((m) => CHART_TYPES.includes(m.type))
    return (
      <div className="space-y-3">
        <Label htmlFor="builder-prop-chart-monitor">Monitor</Label>
        <select
          id="builder-prop-chart-monitor"
          value={n.monitorId}
          onChange={(e) => onUpdate({ monitorId: Number(e.target.value) } as Partial<ChartNode>)}
          className={cls}
        >
          {compatibleMonitors.map((m) => (
            <option key={m.id} value={m.id}>[{m.type.toUpperCase()}] {m.name}</option>
          ))}
        </select>

        <Label htmlFor="builder-prop-title">Title (optional)</Label>
        <input
          id="builder-prop-title"
          value={n.title ?? ''}
          onChange={(e) => onUpdate({ title: e.target.value || undefined } as Partial<ChartNode>)}
          className={cls}
          placeholder="Leave empty to use monitor name"
        />

        <Label htmlFor="builder-prop-hours">Time range</Label>
        <select
          id="builder-prop-hours"
          value={n.hours}
          onChange={(e) => onUpdate({ hours: Number(e.target.value) } as Partial<ChartNode>)}
          className={cls}
        >
          <option value={1}>Last 1 hour</option>
          <option value={3}>Last 3 hours</option>
          <option value={6}>Last 6 hours</option>
          <option value={12}>Last 12 hours</option>
          <option value={24}>Last 24 hours</option>
          <option value={48}>Last 2 days</option>
          <option value={168}>Last 7 days</option>
        </select>

        <Label htmlFor="builder-prop-buckets">Data points</Label>
        <select
          id="builder-prop-buckets"
          value={n.buckets}
          onChange={(e) => onUpdate({ buckets: Number(e.target.value) } as Partial<ChartNode>)}
          className={cls}
        >
          <option value={20}>20 — sparse</option>
          <option value={30}>30 — balanced</option>
          <option value={50}>50 — dense</option>
        </select>

        <Label id="builder-prop-aggregation">Aggregation</Label>
        <div className="flex gap-1" role="group" aria-labelledby="builder-prop-aggregation">
          {(['avg', 'p95', 'max'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={n.aggregation === v}
              onClick={() => onUpdate({ aggregation: v } as Partial<ChartNode>)}
              className="flex-1 text-xs py-1.5 rounded transition-all focus-ring"
              style={
                n.aggregation === v
                  ? { background: 'var(--admin-selection)', color: 'var(--admin-on-selection)' }
                  : { background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)' }
              }
            >
              {v.toUpperCase()}
            </button>
          ))}
        </div>

        <Label id="builder-prop-chart-height">Chart height</Label>
        <div className="flex gap-1" role="group" aria-labelledby="builder-prop-chart-height">
          {([3, 5, 7] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={(n.chartH ?? 5) === v}
              onClick={() => onUpdate({ chartH: v } as Partial<ChartNode>)}
              className="flex-1 text-xs py-1.5 rounded transition-all focus-ring"
              style={
                (n.chartH ?? 5) === v
                  ? { background: 'var(--admin-selection)', color: 'var(--admin-on-selection)' }
                  : { background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)' }
              }
            >
              {v === 3 ? 'S' : v === 5 ? 'M' : 'L'}
            </button>
          ))}
        </div>

        <Toggle
          label="Fill area under line"
          checked={n.showArea ?? true}
          onChange={(v) => onUpdate({ showArea: v } as Partial<ChartNode>)}
        />
        <Toggle
          label="Show monitor type"
          checked={n.showMonitorType ?? false}
          onChange={(v) => onUpdate({ showMonitorType: v } as Partial<ChartNode>)}
        />
      </div>
    )
  }

  return null
}

/** Small caps label; pass `htmlFor` to tie it to a control, or `id` to name a button group. */
function Label({ children, htmlFor, id }: { children: React.ReactNode; htmlFor?: string; id?: string }) {
  const className = 'block text-[10px] uppercase tracking-wider text-secondary'
  if (htmlFor) return <label htmlFor={htmlFor} className={className}>{children}</label>
  return <p id={id} className={className}>{children}</p>
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-on-surface-variant cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}
