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

// ── Builder page ──────────────────────────────────────────────────────────────
export default function BuilderPage() {
  const {
    tree, setTree, isDirty, markClean,
    addNode, updateNode, deleteNode,
    applyGridLayout, reorderGroupChildren,
    moveToGroup, insertRootNode,
    selectNode, selectedId,
  } = useBuilderStore()

  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // What's currently being dragged from toolbox (for droppingItem size hint)
  const draggingTypeRef = useRef<string>('monitor')
  const [droppingItem, setDroppingItem] = useState<LayoutItem>({
    i: '__dropping__', x: 0, y: 0, w: 1, h: 1,
  })

  const { data: monitors = [] } = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
  })

  useEffect(() => {
    if (monitors.length === 0) return // wait for monitors to load before pruning
    api.get<unknown>('/admin/layout').then((d) => {
      const loaded = d as typeof tree
      const validIds = new Set(monitors.map((m) => m.id))
      const { pruned, removed } = pruneOrphanedMonitors(loaded, validIds)
      setTree(pruned)
      // If any orphaned monitor nodes were stripped, mark dirty so the user can save
      if (removed > 0) useBuilderStore.setState({ isDirty: true })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setTree, monitors.length])

  async function handleSave() {
    setSaving(true)
    try {
      await api.put('/admin/layout', { tree })
      markClean()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
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

    if (type === 'monitor') {
      const monitorId = Number(de.dataTransfer?.getData('monitorId'))
      if (monitorId) insertRootNode({ ...createMonitorNode(monitorId), grid }, dropY)
    } else if (type === 'group') {
      const label = de.dataTransfer?.getData('label') || 'New group'
      insertRootNode({ ...createGroupNode(label), grid }, dropY)
    } else if (type === 'text') {
      insertRootNode({ ...createTextNode(), grid }, dropY)
    } else if (type === 'divider') {
      insertRootNode({ type: 'divider', grid } as Omit<LayoutNode, 'id'>, dropY)
    } else if (type === 'incidents') {
      insertRootNode({ ...createIncidentsNode(), grid }, dropY)
    } else if (type === 'chart') {
      const monitorId = Number(de.dataTransfer?.getData('monitorId'))
      if (monitorId) insertRootNode({ ...createChartNode(monitorId), grid }, dropY)
    }
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
          <p className="text-xs font-semibold" style={{ color: 'var(--m3-on-surface)' }}>Toolbox</p>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--m3-secondary)' }}>Drag onto canvas</p>
        </div>

        <div className="p-3 space-y-4">
          {/* Groups */}
          <section>
            <p className="text-[10px] uppercase tracking-wider text-secondary mb-1.5">Groups</p>
            <div
              draggable
              onDragStart={(e) => {
                handleToolboxDragStart('group', { label: 'New group' })
                e.dataTransfer.setData('nodeType', 'group')
                e.dataTransfer.setData('label', 'New group')
                e.dataTransfer.effectAllowed = 'copy'
              }}
              className="flex items-center gap-2 px-2 py-1.5 bg-surface-container hover:bg-surface-container-high rounded text-sm text-on-surface-variant cursor-grab active:cursor-grabbing select-none"
            >
              <span className="text-secondary">◧</span>
              <span className="truncate">New group</span>
            </div>
          </section>

          {/* Monitors */}
          <section>
            <p className="text-[10px] uppercase tracking-wider text-secondary mb-1.5">Monitors</p>
            <div className="space-y-1">
              {monitors.map((m) => (
                <div
                  key={m.id}
                  draggable
                  onDragStart={(e) => {
                    handleToolboxDragStart('monitor')
                    e.dataTransfer.setData('nodeType', 'monitor')
                    e.dataTransfer.setData('monitorId', String(m.id))
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  className="flex items-center gap-2 px-2 py-1.5 bg-surface-container hover:bg-surface-container-high rounded text-sm text-on-surface-variant cursor-grab active:cursor-grabbing select-none"
                >
                  <span className="text-[9px] uppercase bg-surface-container text-secondary px-1 rounded shrink-0">{m.type}</span>
                  <span className="truncate">{m.name}</span>
                </div>
              ))}
              {monitors.length === 0 && <p className="text-xs text-secondary">No monitors</p>}
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
                <div
                  key={type}
                  draggable
                  onDragStart={(e) => {
                    handleToolboxDragStart(type)
                    e.dataTransfer.setData('nodeType', type)
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  className="flex items-center gap-2 px-2 py-1.5 bg-surface-container hover:bg-surface-container-high rounded text-sm text-on-surface-variant cursor-grab active:cursor-grabbing select-none"
                >
                  <span className="text-secondary font-mono text-xs">{icon}</span>
                  {label}
                </div>
              ))}
            </div>
          </section>

          {/* Charts */}
          {monitors.some((m) => ['https', 'ping', 'sqlserver'].includes(m.type)) && (
            <section>
              <p className="text-[10px] uppercase tracking-wider text-secondary mb-1.5">Charts</p>
              <div className="space-y-1">
                {monitors.filter((m) => ['https', 'ping', 'sqlserver'].includes(m.type)).map((m) => (
                  <div
                    key={m.id}
                    draggable
                    onDragStart={(e) => {
                      handleToolboxDragStart('chart')
                      e.dataTransfer.setData('nodeType', 'chart')
                      e.dataTransfer.setData('monitorId', String(m.id))
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    className="flex items-center gap-2 px-2 py-1.5 bg-surface-container hover:bg-surface-container-high rounded text-sm text-on-surface-variant cursor-grab active:cursor-grabbing select-none"
                  >
                    <span className="text-secondary font-mono text-xs">↗</span>
                    <span className="text-[9px] uppercase bg-surface-container text-secondary px-1 rounded shrink-0">{m.type}</span>
                    <span className="truncate">{m.name}</span>
                  </div>
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
              <button onClick={() => selectNode(null)} className="text-secondary hover:text-on-surface text-base leading-none">×</button>
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
            <h2 className="text-sm font-semibold" style={{ color: 'var(--m3-on-surface)' }}>Page Builder</h2>
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--m3-secondary)' }}>Drag from toolbox · Resize horizontally (1–3 col) · Click to edit</p>
          </div>
          <div className="flex items-center gap-3">
            {isDirty && <span className="text-xs" style={{ color: 'var(--m3-degraded)' }}>Unsaved</span>}
            {saved && <span className="text-xs" style={{ color: 'var(--m3-up)' }}>Saved!</span>}
            <button
              onClick={handleSave}
              disabled={saving || !isDirty}
              className="btn-primary text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
              style={{
                background: saving || !isDirty ? 'var(--m3-surface-container-high)' : 'var(--m3-primary)',
                color: saving || !isDirty ? 'var(--m3-secondary)' : 'var(--m3-on-primary)',
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4" style={{ background: 'var(--m3-surface-container-low)' }}>
          {tree.children.length === 0 ? (
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
                    onDelete={() => deleteNode(node.id)}
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
        <p className="text-sm">Drag elements from the toolbox</p>
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

function DeleteBtn({ onDelete }: { onDelete: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onDelete() }}
      className="absolute top-1 right-1 z-10 w-5 h-5 flex items-center justify-center rounded text-secondary hover:text-on-surface hover:bg-red-500 transition-colors text-xs leading-none"
      title="Delete"
    >
      ×
    </button>
  )
}

function NodeCard(props: NodeCardProps) {
  const { node, isSelected, onSelect, onSelectChild, onDelete, onMoveToGroup } = props
  const ring = isSelected ? 'ring-2 ring-primary' : 'ring-1 ring-outline-variant'

  if (node.type === 'divider') {
    return (
      <div className={`relative h-full flex items-center rounded-lg bg-surface-container-low overflow-hidden ${ring}`} onClick={onSelect}>
        <span className="drag-handle cursor-grab px-2 text-secondary hover:text-on-surface-variant self-stretch flex items-center">⠿</span>
        <hr className="flex-1 border-outline-variant mr-6" />
        <DeleteBtn onDelete={onDelete} />
      </div>
    )
  }

  if (node.type === 'text') {
    const n = node as TextNode
    return (
      <div className={`relative h-full flex flex-col rounded-lg bg-surface-container-low overflow-hidden ${ring}`} onClick={onSelect}>
        <DeleteBtn onDelete={onDelete} />
        <div className="flex items-center gap-1 px-2 py-1.5 shrink-0 pr-7 border-b border-outline-variant/40">
          <span className="drag-handle cursor-grab text-secondary hover:text-on-surface-variant">⠿</span>
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
      <div className={`relative h-full flex items-center gap-2 px-3 rounded-lg bg-surface-container-low ${ring}`} onClick={onSelect}>
        <DeleteBtn onDelete={onDelete} />
        <span className="drag-handle cursor-grab text-secondary hover:text-on-surface-variant shrink-0">⠿</span>
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
      <div className={`relative h-full flex items-center gap-2 px-3 rounded-lg bg-surface-container-low ${ring}`} onClick={onSelect}>
        <DeleteBtn onDelete={onDelete} />
        <span className="drag-handle cursor-grab text-secondary hover:text-on-surface-variant shrink-0">⠿</span>
        <span className="material-symbols-outlined text-secondary shrink-0" style={{ fontSize: '16px' }}>warning</span>
        <span className="flex-1 text-sm text-on-surface truncate pr-5">Incydenty · {filterLabel}</span>
      </div>
    )
  }

  if (node.type === 'chart') {
    const n = node as ChartNode
    const monitor = props.monitors.find((m) => m.id === n.monitorId)
    const rangeLabel = n.hours < 24 ? `${n.hours}h` : n.hours === 24 ? '24h' : n.hours === 48 ? '2d' : '7d'
    const sizeLabel = n.chartH === 3 ? 'S' : n.chartH === 7 ? 'L' : 'M'
    return (
      <div className={`relative h-full flex items-center gap-2 px-3 rounded-lg bg-surface-container-low ${ring}`} onClick={onSelect}>
        <DeleteBtn onDelete={onDelete} />
        <span className="drag-handle cursor-grab text-secondary hover:text-on-surface-variant shrink-0">⠿</span>
        <span className="text-secondary font-mono text-xs shrink-0">↗</span>
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
    <div className={`relative h-full flex flex-col rounded-xl bg-surface-container-low overflow-hidden ${ring}`} onClick={onSelect}>
      <DeleteBtn onDelete={onDelete} />
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 pr-7">
        <span className="drag-handle cursor-grab text-secondary hover:text-on-surface-variant">⠿</span>
        <span className="text-on-surface-variant text-sm">◧</span>
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

  return (
    <div
      ref={setNodeRef}
      style={{
        ...style,
        background: isSelected ? 'color-mix(in srgb, var(--m3-primary) 15%, transparent)' : 'var(--m3-surface-container)',
        outline: isSelected ? '1px solid color-mix(in srgb, var(--m3-primary) 50%, transparent)' : 'none',
      }}
      className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm cursor-pointer"
      onClick={onSelect}
    >
      <span
        {...attributes}
        {...listeners}
        className="cursor-grab text-secondary hover:text-on-surface-variant touch-none"
        onClick={(e) => e.stopPropagation()}
      >
        ⠿
      </span>
      {monitor ? (
        <>
          <span className="text-[9px] uppercase bg-surface-container text-secondary px-1 rounded">{monitor.type}</span>
          <span className="flex-1 text-on-surface-variant truncate">{monitor.name}</span>
        </>
      ) : child.type === 'text' ? (
        <>
          <span className="text-[9px] uppercase bg-surface-container text-secondary px-1 rounded">T</span>
          <span className="flex-1 text-on-surface-variant truncate">{(child as TextNode).name || 'Text'}</span>
        </>
      ) : (
        <span className="flex-1 text-on-surface-variant truncate">{child.id}</span>
      )}
      <button onClick={(e) => { e.stopPropagation(); onDelete() }} className="text-secondary hover:text-status-down text-xs leading-none shrink-0">×</button>
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
        <Label>Name</Label>
        <input
          value={n.name ?? ''}
          onChange={(e) => onUpdate({ name: e.target.value } as Partial<TextNode>)}
          className={cls}
          placeholder="New text"
        />
        <Label>Text (Markdown)</Label>
        <textarea
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
        <Label>Monitor</Label>
        <select value={n.monitorId} onChange={(e) => onUpdate({ monitorId: Number(e.target.value) } as Partial<MonitorNode>)} className={cls}>
          {monitors.map((m) => <option key={m.id} value={m.id}>[{m.type.toUpperCase()}] {m.name}</option>)}
        </select>

        <div>
          <Label>Card type</Label>
          <div className="flex gap-1 mt-1">
            {(['default', 'compact'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => onUpdate({ cardVariant: v } as Partial<MonitorNode>)}
                className="flex-1 text-xs py-1.5 rounded transition-all"
                style={
                  (n.cardVariant ?? 'default') === v
                    ? { background: 'var(--m3-primary)', color: 'var(--m3-on-primary)' }
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
                <Label>Uptime bar position</Label>
                <select
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
        <Label>Group name</Label>
        <input value={n.label} onChange={(e) => onUpdate({ label: e.target.value } as Partial<GroupNode>)} className={cls} />
        <Toggle label="Collapsible" checked={n.collapsible}
          onChange={(v) => onUpdate({ collapsible: v } as Partial<GroupNode>)} />
        <div className="border-t pt-3">
          <Label>Add monitor to group</Label>
          <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
            {monitors.map((m) => (
              <button key={m.id} onClick={() => onAddChild(createMonitorNode(m.id))}
                className="w-full text-left text-xs text-on-surface-variant hover:text-on-surface px-2 py-1.5 rounded hover:bg-surface-container-high flex items-center gap-2">
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
        <Label>Incident limit</Label>
        <input
          type="number"
          min={1}
          max={20}
          value={n.limit ?? 5}
          onChange={(e) => onUpdate({ limit: Number(e.target.value) } as Partial<IncidentsNode>)}
          className={cls}
        />
        <Label>Filter</Label>
        <select
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
    const compatibleMonitors = monitors.filter((m) => ['https', 'ping', 'sqlserver'].includes(m.type))
    return (
      <div className="space-y-3">
        <Label>Monitor</Label>
        <select
          value={n.monitorId}
          onChange={(e) => onUpdate({ monitorId: Number(e.target.value) } as Partial<ChartNode>)}
          className={cls}
        >
          {compatibleMonitors.map((m) => (
            <option key={m.id} value={m.id}>[{m.type.toUpperCase()}] {m.name}</option>
          ))}
        </select>

        <Label>Title (optional)</Label>
        <input
          value={n.title ?? ''}
          onChange={(e) => onUpdate({ title: e.target.value || undefined } as Partial<ChartNode>)}
          className={cls}
          placeholder="Leave empty to use monitor name"
        />

        <Label>Time range</Label>
        <select
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

        <Label>Data points</Label>
        <select
          value={n.buckets}
          onChange={(e) => onUpdate({ buckets: Number(e.target.value) } as Partial<ChartNode>)}
          className={cls}
        >
          <option value={20}>20 — sparse</option>
          <option value={30}>30 — balanced</option>
          <option value={50}>50 — dense</option>
        </select>

        <Label>Aggregation</Label>
        <div className="flex gap-1">
          {(['avg', 'p95', 'max'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onUpdate({ aggregation: v } as Partial<ChartNode>)}
              className="flex-1 text-xs py-1.5 rounded transition-all"
              style={
                n.aggregation === v
                  ? { background: 'var(--m3-primary)', color: 'var(--m3-on-primary)' }
                  : { background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)' }
              }
            >
              {v.toUpperCase()}
            </button>
          ))}
        </div>

        <Label>Chart height</Label>
        <div className="flex gap-1">
          {([3, 5, 7] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onUpdate({ chartH: v } as Partial<ChartNode>)}
              className="flex-1 text-xs py-1.5 rounded transition-all"
              style={
                (n.chartH ?? 5) === v
                  ? { background: 'var(--m3-primary)', color: 'var(--m3-on-primary)' }
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

function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] uppercase tracking-wider text-secondary">{children}</p>
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-on-surface-variant cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-indigo-500" />
      {label}
    </label>
  )
}
