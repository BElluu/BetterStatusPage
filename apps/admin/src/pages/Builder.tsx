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
  useBuilderStore, createMonitorNode, createGroupNode, createTextNode,
  defaultGrid, findNode,
} from '../components/builder/useBuilderStore'
import type {
  Monitor, LayoutNode, GroupNode, MonitorNode, TextNode, GridPos,
} from '@bsp/shared'

// ── react-grid-layout setup ───────────────────────────────────────────────────
const RGL = WidthProvider(ReactGridLayout)
const ROW_H = 80
const COLS = 12

// ── Builder page ──────────────────────────────────────────────────────────────
export default function BuilderPage() {
  const {
    tree, setTree, isDirty, markClean,
    addNode, updateNode, deleteNode,
    applyGridLayout, reorderGroupChildren,
    selectNode, selectedId,
  } = useBuilderStore()

  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')

  // What's currently being dragged from toolbox (for droppingItem size hint)
  const draggingTypeRef = useRef<string>('monitor')
  const [droppingItem, setDroppingItem] = useState<LayoutItem>({
    i: '__dropping__', x: 0, y: 0, w: 4, h: 2,
  })

  const { data: monitors = [] } = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
  })

  useEffect(() => {
    api.get<unknown>('/admin/layout').then((d) => setTree(d as typeof tree))
  }, [setTree])

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
  const rglLayout: LayoutItem[] = useMemo(() =>
    tree.children.map((node, i) => {
      const g = node.grid ?? { ...defaultGrid(node.type), y: i * 3 }
      return { i: node.id, x: g.x, y: g.y, w: g.w, h: g.h, minH: 1, minW: 1 }
    }),
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
    const grid: GridPos = { x: item?.x ?? 0, y: item?.y ?? 0, w: item?.w ?? 4, h: item?.h ?? 2 }

    if (type === 'monitor') {
      const monitorId = Number(de.dataTransfer?.getData('monitorId'))
      if (monitorId) addNode('root', { ...createMonitorNode(monitorId), grid })
    } else if (type === 'group') {
      const label = de.dataTransfer?.getData('label') || 'Nowa grupa'
      addNode('root', { ...createGroupNode(label), grid })
    } else if (type === 'text') {
      addNode('root', { ...createTextNode(), grid })
    } else if (type === 'divider') {
      addNode('root', { type: 'divider', grid })
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
    <div className="flex h-full overflow-hidden" style={{ '--rgl-placeholder-bg': 'rgba(99,102,241,0.15)' } as React.CSSProperties}>
      {/* ── Toolbox + Properties ── */}
      <aside className="w-56 flex flex-col bg-slate-900 border-r border-slate-800 shrink-0 overflow-y-auto">
        <div className="p-3 border-b border-slate-800">
          <p className="text-xs font-semibold text-white">Toolbox</p>
          <p className="text-[10px] text-slate-500 mt-0.5">Przeciągnij na canvas</p>
        </div>

        <div className="p-3 space-y-4">
          {/* Groups */}
          <section>
            <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">Grupy</p>
            <form onSubmit={(e) => {
              e.preventDefault()
              if (!newGroupName.trim()) return
              const g = defaultGrid('group')
              addNode('root', { ...createGroupNode(newGroupName.trim()), grid: g })
              setNewGroupName('')
            }} className="flex gap-1 mb-2">
              <input
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="Nazwa grupy…"
                className="flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-indigo-500"
              />
              <button type="submit" disabled={!newGroupName.trim()}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs px-2 py-1 rounded">
                +
              </button>
            </form>
            {newGroupName.trim() && (
              <div
                draggable
                onDragStart={(e) => {
                  const data = handleToolboxDragStart('group', { label: newGroupName.trim() })
                  e.dataTransfer.setData('nodeType', 'group')
                  e.dataTransfer.setData('label', data['label'] ?? newGroupName)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                className="flex items-center gap-2 px-2 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-sm text-slate-300 cursor-grab active:cursor-grabbing select-none"
              >
                <span className="text-slate-500">◧</span>
                <span className="truncate">{newGroupName}</span>
              </div>
            )}
          </section>

          {/* Monitors */}
          <section>
            <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">Monitory</p>
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
                  onClick={() => {
                    // Click fallback: add to selected group or root
                    const parentId = selectedId && findNode(tree.children, selectedId)?.type === 'group'
                      ? selectedId : 'root'
                    addNode(parentId, createMonitorNode(m.id))
                  }}
                  className="flex items-center gap-2 px-2 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-sm text-slate-300 cursor-grab active:cursor-grabbing select-none"
                >
                  <span className="text-[9px] uppercase bg-slate-700 text-slate-400 px-1 rounded shrink-0">{m.type}</span>
                  <span className="truncate">{m.name}</span>
                </div>
              ))}
              {monitors.length === 0 && <p className="text-xs text-slate-600">Brak monitorów</p>}
            </div>
          </section>

          {/* Blocks */}
          <section>
            <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">Bloki</p>
            <div className="space-y-1">
              {[
                { type: 'text', label: 'Tekst', icon: 'T' },
                { type: 'divider', label: 'Separator', icon: '—' },
              ].map(({ type, label, icon }) => (
                <div
                  key={type}
                  draggable
                  onDragStart={(e) => {
                    handleToolboxDragStart(type)
                    e.dataTransfer.setData('nodeType', type)
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => {
                    const grid = defaultGrid(type)
                    if (type === 'text') addNode('root', { ...createTextNode(), grid })
                    else addNode('root', { type: 'divider', grid })
                  }}
                  className="flex items-center gap-2 px-2 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-sm text-slate-300 cursor-grab active:cursor-grabbing select-none"
                >
                  <span className="text-slate-500 font-mono text-xs">{icon}</span>
                  {label}
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* ── Properties (below toolbox, when element selected) ── */}
        {selectedNode && (
          <div className="border-t border-slate-800 flex flex-col">
            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
              <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">Właściwości</p>
              <button onClick={() => selectNode(null)} className="text-slate-500 hover:text-white text-base leading-none">×</button>
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
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-white">Page Builder</h2>
            <p className="text-[10px] text-slate-500 mt-0.5">Przeciągnij z toolboxa · Zmień rozmiar za uchwytem · Kliknij = edycja</p>
          </div>
          <div className="flex items-center gap-3">
            {isDirty && <span className="text-xs text-amber-400">Niezapisane</span>}
            {saved && <span className="text-xs text-emerald-400">Zapisano!</span>}
            <button
              onClick={handleSave}
              disabled={saving || !isDirty}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
            >
              {saving ? 'Zapisuję…' : 'Zapisz'}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4 bg-[#080d18]">
          {tree.children.length === 0 ? (
            <EmptyDrop onDrop={handleDrop} droppingItem={droppingItem} rglLayout={rglLayout} />
          ) : (
            <RGL
              layout={rglLayout}
              cols={COLS}
              rowHeight={ROW_H}
              margin={[10, 10]}
              containerPadding={[0, 0]}
              draggableHandle=".drag-handle"
              isDroppable
              droppingItem={droppingItem}
              onDrop={handleDrop}
              onLayoutChange={handleLayoutChange}
              resizeHandles={['se', 's', 'e']}
              useCSSTransforms
            >
              {tree.children.map((node) => (
                <div key={node.id}>
                  <NodeCard
                    node={node}
                    monitors={monitors}
                    isSelected={selectedId === node.id}
                    onSelect={() => selectNode(selectedId === node.id ? null : node.id)}
                    onDelete={() => deleteNode(node.id)}
                    onUpdate={(patch) => updateNode(node.id, patch)}
                    onAddChild={(n) => addNode(node.id, n)}
                    sensors={sensors}
                    onGroupDragEnd={handleGroupDragEnd(node.id)}
                  />
                </div>
              ))}
            </RGL>
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
        onLayoutChange={() => {}}
        resizeHandles={['se', 's', 'e']}
        style={{ minHeight: 260 }}
      >{null}</RGL>
      <div className="flex items-center justify-center h-48 border-2 border-dashed border-slate-700 rounded-xl text-slate-500 -mt-10 pointer-events-none">
        <p className="text-sm">Przeciągnij elementy z toolboxa</p>
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
  onDelete: () => void
  onUpdate: (patch: Partial<LayoutNode>) => void
  onAddChild: (n: Omit<LayoutNode, 'id'>) => void
  sensors: ReturnType<typeof useSensors>
  onGroupDragEnd: (e: DragEndEvent) => void
}

function NodeCard(props: NodeCardProps) {
  const { node, isSelected, onSelect, onDelete } = props
  const ring = isSelected ? 'ring-2 ring-indigo-500' : 'ring-1 ring-slate-700/60'

  if (node.type === 'divider') {
    return (
      <div className={`h-full flex items-center rounded-lg bg-slate-900 overflow-hidden ${ring}`} onClick={onSelect}>
        <span className="drag-handle cursor-grab px-2 text-slate-600 hover:text-slate-400 self-stretch flex items-center">⠿</span>
        <hr className="flex-1 border-slate-600" />
        <button onClick={(e) => { e.stopPropagation(); onDelete() }} className="px-2 text-slate-600 hover:text-red-400 self-stretch flex items-center">×</button>
      </div>
    )
  }

  if (node.type === 'text') {
    const n = node as TextNode
    return (
      <div className={`h-full flex flex-col rounded-lg bg-slate-900 overflow-hidden ${ring}`} onClick={onSelect}>
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-slate-800 shrink-0">
          <span className="drag-handle cursor-grab text-slate-600 hover:text-slate-400">⠿</span>
          <span className="text-[10px] text-slate-500 flex-1">Tekst</span>
          <button onClick={(e) => { e.stopPropagation(); onDelete() }} className="text-slate-600 hover:text-red-400 text-sm leading-none">×</button>
        </div>
        <div className="flex-1 px-3 py-2 overflow-hidden">
          <p className="text-xs text-slate-400 line-clamp-4 whitespace-pre-wrap">{n.markdown}</p>
        </div>
      </div>
    )
  }

  if (node.type === 'monitor') {
    const n = node as MonitorNode
    const monitor = props.monitors.find((m) => m.id === n.monitorId)
    return (
      <div className={`h-full flex items-center gap-2 px-3 rounded-lg bg-slate-900 overflow-hidden ${ring}`} onClick={onSelect}>
        <span className="drag-handle cursor-grab text-slate-600 hover:text-slate-400 shrink-0">⠿</span>
        <span className="text-[9px] uppercase bg-slate-800 text-slate-400 px-1 py-0.5 rounded shrink-0">{monitor?.type ?? '?'}</span>
        <span className="flex-1 text-sm text-white truncate">{monitor?.name ?? `#${n.monitorId}`}</span>
        <button onClick={(e) => { e.stopPropagation(); onDelete() }} className="text-slate-600 hover:text-red-400 shrink-0 text-sm leading-none">×</button>
      </div>
    )
  }

  if (node.type === 'group') {
    return <GroupCard {...props} node={node as GroupNode} />
  }

  return null
}

// ── Group card (with inner @dnd-kit sortable) ─────────────────────────────────
function GroupCard({
  node, monitors, isSelected, onSelect, onDelete, onUpdate, onAddChild,
  sensors, onGroupDragEnd,
}: Omit<NodeCardProps, 'node'> & { node: GroupNode }) {
  const ring = isSelected ? 'ring-2 ring-indigo-500' : 'ring-1 ring-slate-700/60'
  const [isDragOver, setIsDragOver] = useState(false)

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation() // prevent RGL canvas from showing its own drop placeholder
    e.dataTransfer.dropEffect = 'copy'
    setIsDragOver(true)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    const type = e.dataTransfer.getData('nodeType')
    if (type === 'monitor') {
      const monitorId = Number(e.dataTransfer.getData('monitorId'))
      if (monitorId) onAddChild(createMonitorNode(monitorId))
    } else if (type === 'text') {
      onAddChild(createTextNode())
    }
  }

  return (
    <div className={`h-full flex flex-col rounded-xl bg-slate-900 overflow-hidden ${ring}`} onClick={onSelect}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800 shrink-0">
        <span className="drag-handle cursor-grab text-slate-600 hover:text-slate-400">⠿</span>
        <span className="text-slate-400 text-sm">◧</span>
        <span className="flex-1 text-sm font-medium text-white truncate">{node.label || 'Grupa'}</span>
        <span className="text-[10px] text-slate-600">{node.children.length}</span>
        <button onClick={(e) => { e.stopPropagation(); onDelete() }} className="text-slate-600 hover:text-red-400 text-sm leading-none ml-1">×</button>
      </div>

      {/* Children (sortable + drop target) */}
      <div
        className={`flex-1 overflow-y-auto p-2 transition-colors ${isDragOver ? 'bg-indigo-500/10' : ''}`}
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
          isDragOver ? 'border-indigo-500 text-indigo-400' : 'border-slate-700 text-slate-600'
        }`}>
          {isDragOver ? 'Upuść tutaj' : 'Przeciągnij monitor z toolboxa'}
        </div>
      </div>
    </div>
  )
}

function SortableGroupItem({
  child, monitors, onDelete,
}: { child: LayoutNode; monitors: Monitor[]; onDelete: () => void }) {
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
    <div ref={setNodeRef} style={style}
      className="flex items-center gap-2 px-2 py-1.5 bg-slate-800 hover:bg-slate-750 rounded-lg text-sm"
    >
      <span {...attributes} {...listeners} className="cursor-grab text-slate-600 hover:text-slate-400 touch-none">⠿</span>
      {monitor ? (
        <>
          <span className="text-[9px] uppercase bg-slate-700 text-slate-400 px-1 rounded">{monitor.type}</span>
          <span className="flex-1 text-slate-300 truncate">{monitor.name}</span>
        </>
      ) : (
        <span className="flex-1 text-slate-400 truncate">{(child as MonitorNode).monitorId ?? child.id}</span>
      )}
      <button onClick={onDelete} className="text-slate-600 hover:text-red-400 text-xs leading-none shrink-0">×</button>
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
  const cls = 'w-full bg-slate-800 border border-slate-700 rounded px-2.5 py-1.5 text-white text-xs focus:outline-none focus:border-indigo-500'

  if (node.type === 'text') {
    const n = node as TextNode
    return (
      <div className="space-y-3">
        <Label>Tekst (Markdown)</Label>
        <textarea
          value={n.markdown}
          onChange={(e) => onUpdate({ markdown: e.target.value } as Partial<TextNode>)}
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
        <Toggle label="Wykres uptime" checked={n.showUptimeBar}
          onChange={(v) => onUpdate({ showUptimeBar: v } as Partial<MonitorNode>)} />
        <Toggle label="Czas odpowiedzi" checked={n.showResponseTime}
          onChange={(v) => onUpdate({ showResponseTime: v } as Partial<MonitorNode>)} />
      </div>
    )
  }

  if (node.type === 'group') {
    const n = node as GroupNode
    return (
      <div className="space-y-3">
        <Label>Nazwa grupy</Label>
        <input value={n.label} onChange={(e) => onUpdate({ label: e.target.value } as Partial<GroupNode>)} className={cls} />
        <Toggle label="Zwijalna" checked={n.collapsible}
          onChange={(v) => onUpdate({ collapsible: v } as Partial<GroupNode>)} />
        <div className="border-t border-slate-800 pt-3">
          <Label>Dodaj monitor do grupy</Label>
          <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
            {monitors.map((m) => (
              <button key={m.id} onClick={() => onAddChild(createMonitorNode(m.id))}
                className="w-full text-left text-xs text-slate-300 hover:text-white px-2 py-1.5 rounded hover:bg-slate-800 flex items-center gap-2">
                <span className="text-[9px] uppercase text-slate-500">{m.type}</span>
                {m.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return null
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] uppercase tracking-wider text-slate-500">{children}</p>
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-indigo-500" />
      {label}
    </label>
  )
}
