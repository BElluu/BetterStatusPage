import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { api } from '../api/client'
import {
  useBuilderStore,
  createMonitorNode,
  createGroupNode,
  findParentId,
  findNode,
} from '../components/builder/useBuilderStore'
import type { Monitor, LayoutNode, GroupNode, MonitorNode, TextNode } from '@bsp/shared'

// ── Builder page ──────────────────────────────────────────────────────────────

export default function BuilderPage() {
  const { tree, setTree, isDirty, markClean, addNode, deleteNode, updateNode, selectNode, selectedId, reorderInParent, moveToParent } =
    useBuilderStore()

  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  // Track which group is currently dragged over (for highlight)
  const overGroupRef = useRef<string | null>(null)

  const { data: monitors = [] } = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
  })

  useEffect(() => {
    api.get<unknown>('/admin/layout').then((data) => {
      setTree(data as typeof tree)
    })
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

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  function handleDragStart({ active }: DragStartEvent) {
    setActiveId(active.id as string)
  }

  function handleDragOver({ over }: DragOverEvent) {
    // Track if we're hovering over a droppable group zone
    if (over?.id && String(over.id).startsWith('zone-')) {
      overGroupRef.current = String(over.id).slice(5)
    } else {
      overGroupRef.current = null
    }
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    const draggedId = active.id as string
    setActiveId(null)
    overGroupRef.current = null

    if (!over) return

    const overId = String(over.id)

    // Dropped on a group's empty drop zone
    if (overId.startsWith('zone-')) {
      const targetGroupId = overId.slice(5)
      if (draggedId !== targetGroupId) {
        moveToParent(draggedId, targetGroupId)
      }
      return
    }

    if (draggedId === overId) return

    // Both are items — determine their containers
    const activeContainer = findParentId(tree, draggedId) ?? 'root'
    const overContainer = findParentId(tree, overId) ?? 'root'

    if (activeContainer === overContainer) {
      reorderInParent(activeContainer, draggedId, overId)
    } else {
      moveToParent(draggedId, overContainer, overId)
    }
  }

  const activeNode = activeId ? findNode(tree.children, activeId) : null

  const selectedNode = selectedId ? findNode(tree.children, selectedId) : null

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Toolbox ──────────────────────────────────────────── */}
      <aside className="w-60 flex flex-col bg-slate-900 border-r border-slate-800 shrink-0">
        <div className="p-4 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-white">Toolbox</h3>
          <p className="text-xs text-slate-500 mt-0.5">Kliknij aby dodać do canvas</p>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-5">
          {/* Create group */}
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Nowa grupa</p>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (!newGroupName.trim()) return
                // Add to selected group if one is selected, else root
                const parentId =
                  selectedId && findNode(tree.children, selectedId)?.type === 'group'
                    ? selectedId
                    : 'root'
                addNode(parentId, createGroupNode(newGroupName.trim()))
                setNewGroupName('')
              }}
              className="flex gap-1.5"
            >
              <input
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="Nazwa grupy…"
                className="flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:border-indigo-500"
              />
              <button
                type="submit"
                disabled={!newGroupName.trim()}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs px-2.5 py-1.5 rounded-lg"
              >
                +
              </button>
            </form>
          </div>

          {/* Monitors */}
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Monitory</p>
            <p className="text-xs text-slate-600 mb-2">Kliknij aby dodać do canvas lub zaznaczonej grupy</p>
            <div className="space-y-1">
              {monitors.map((monitor) => (
                <button
                  key={monitor.id}
                  onClick={() => {
                    // If a group is selected in canvas, add directly to it
                    const parentId =
                      selectedId && findNode(tree.children, selectedId)?.type === 'group'
                        ? selectedId
                        : 'root'
                    addNode(parentId, createMonitorNode(monitor.id))
                  }}
                  className="w-full flex items-center gap-2 text-left text-sm text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg px-3 py-2 transition-colors"
                >
                  <span className="text-xs text-slate-500 uppercase bg-slate-700 px-1 rounded shrink-0">
                    {monitor.type}
                  </span>
                  <span className="truncate">{monitor.name}</span>
                </button>
              ))}
              {monitors.length === 0 && <p className="text-xs text-slate-600">Brak monitorów</p>}
            </div>
          </div>

          {/* Blocks */}
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Bloki</p>
            <div className="space-y-1">
              <button
                onClick={() =>
                  addNode('root', {
                    type: 'text',
                    markdown: '## Sekcja\nOpis…',
                  } as Omit<TextNode, 'id'>)
                }
                className="w-full flex items-center gap-2 text-left text-sm text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg px-3 py-2 transition-colors"
              >
                <span className="text-slate-500 text-xs font-mono">T</span>
                Blok tekstowy
              </button>
              <button
                onClick={() => addNode('root', { type: 'divider' })}
                className="w-full flex items-center gap-2 text-left text-sm text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg px-3 py-2 transition-colors"
              >
                <span className="text-slate-500">—</span>
                Separator
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* ── Canvas ───────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-3.5 border-b border-slate-800 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-white">Page Builder</h2>
            <p className="text-xs text-slate-500 mt-0.5">Przeciągnij aby zmienić kolejność · Kliknij aby edytować</p>
          </div>
          <div className="flex items-center gap-3">
            {isDirty && <span className="text-xs text-amber-400">Niezapisane zmiany</span>}
            {saved && <span className="text-xs text-emerald-400">Zapisano!</span>}
            <button
              onClick={handleSave}
              disabled={saving || !isDirty}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              {saving ? 'Zapisywanie…' : 'Zapisz layout'}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
          >
            {tree.children.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 border-2 border-dashed border-slate-700 rounded-xl text-slate-500">
                <p className="text-base">Pusty canvas</p>
                <p className="text-sm mt-1">Dodaj grupę lub monitor z toolboxa</p>
              </div>
            ) : (
              <SortableContext
                id="root"
                items={tree.children.map((n) => n.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-2">
                  {tree.children.map((node) => (
                    <SortableNode
                      key={node.id}
                      node={node}
                      monitors={monitors}
                      selectedId={selectedId}
                      onSelect={selectNode}
                      onDelete={deleteNode}
                      onUpdate={updateNode}
                      onAddToGroup={(groupId, n) => addNode(groupId, n)}
                    />
                  ))}
                </div>
              </SortableContext>
            )}

            <DragOverlay dropAnimation={null}>
              {activeNode ? (
                <DragPreview node={activeNode} monitors={monitors} />
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      </div>

      {/* ── Properties panel ─────────────────────────────────── */}
      {selectedNode && (
        <aside className="w-72 flex flex-col bg-slate-900 border-l border-slate-800 shrink-0">
          <div className="flex items-center justify-between p-4 border-b border-slate-800">
            <h3 className="text-sm font-semibold text-white">Właściwości</h3>
            <button onClick={() => selectNode(null)} className="text-slate-400 hover:text-white text-xl leading-none">
              ×
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <PropertiesPanel
              node={selectedNode}
              monitors={monitors}
              onUpdate={updateNode}
              onAddToGroup={(groupId, n) => addNode(groupId, n)}
            />
          </div>
        </aside>
      )}
    </div>
  )
}

// ── Sortable wrapper ──────────────────────────────────────────────────────────

function SortableNode({
  node,
  monitors,
  selectedId,
  onSelect,
  onDelete,
  onUpdate,
  onAddToGroup,
}: {
  node: LayoutNode
  monitors: Monitor[]
  selectedId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onUpdate: (id: string, patch: Partial<LayoutNode>) => void
  onAddToGroup: (groupId: string, node: Omit<LayoutNode, 'id'>) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: node.id,
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  return (
    <div ref={setNodeRef} style={style}>
      <NodeView
        node={node}
        monitors={monitors}
        selectedId={selectedId}
        onSelect={onSelect}
        onDelete={onDelete}
        onUpdate={onUpdate}
        onAddToGroup={onAddToGroup}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  )
}

// ── Node renderers ────────────────────────────────────────────────────────────

interface NodeViewProps {
  node: LayoutNode
  monitors: Monitor[]
  selectedId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onUpdate: (id: string, patch: Partial<LayoutNode>) => void
  onAddToGroup: (groupId: string, node: Omit<LayoutNode, 'id'>) => void
  dragHandleProps: React.HTMLAttributes<HTMLElement>
}

function NodeView(props: NodeViewProps) {
  const { node, monitors, selectedId, onSelect, onDelete, dragHandleProps } = props

  const isSelected = selectedId === node.id
  const ring = isSelected ? 'ring-2 ring-indigo-500' : ''

  if (node.type === 'divider') {
    return (
      <div
        className={`flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-700 cursor-pointer hover:border-slate-600 ${ring}`}
        onClick={() => onSelect(node.id)}
      >
        <span {...dragHandleProps} className="cursor-grab text-slate-600 hover:text-slate-400 touch-none">⠿</span>
        <hr className="flex-1 border-slate-600" />
        <span className="text-xs text-slate-500">Separator</span>
        <DeleteBtn onClick={() => onDelete(node.id)} />
      </div>
    )
  }

  if (node.type === 'text') {
    const n = node as TextNode
    return (
      <div
        className={`rounded-lg border border-slate-700 hover:border-slate-600 cursor-pointer bg-slate-900 ${ring}`}
        onClick={() => onSelect(node.id)}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-700/50">
          <span {...dragHandleProps} className="cursor-grab text-slate-600 hover:text-slate-400 touch-none">⠿</span>
          <span className="text-xs text-slate-400 flex-1">Blok tekstowy</span>
          <DeleteBtn onClick={() => onDelete(node.id)} />
        </div>
        <p className="px-3 py-2 text-sm text-slate-400 line-clamp-2">{n.markdown}</p>
      </div>
    )
  }

  if (node.type === 'monitor') {
    const n = node as MonitorNode
    const monitor = monitors.find((m) => m.id === n.monitorId)
    return (
      <div
        className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border border-slate-700 hover:border-slate-600 bg-slate-900 cursor-pointer ${ring}`}
        onClick={() => onSelect(node.id)}
      >
        <span {...dragHandleProps} className="cursor-grab text-slate-600 hover:text-slate-400 touch-none">⠿</span>
        <span className="text-xs uppercase text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded shrink-0">
          {monitor?.type ?? '?'}
        </span>
        <span className="flex-1 text-sm text-white truncate">{monitor?.name ?? `Monitor #${n.monitorId}`}</span>
        <DeleteBtn onClick={() => onDelete(node.id)} />
      </div>
    )
  }

  if (node.type === 'group') {
    return <GroupNodeView {...props} node={node as GroupNode} />
  }

  return null
}

function GroupNodeView({
  node,
  monitors,
  selectedId,
  onSelect,
  onDelete,
  onUpdate,
  onAddToGroup,
  dragHandleProps,
}: NodeViewProps & { node: GroupNode }) {
  const isSelected = selectedId === node.id
  const ring = isSelected ? 'ring-2 ring-indigo-500' : ''

  // Droppable zone for empty groups or when dragging over the group header
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `zone-${node.id}` })

  return (
    <div className={`rounded-xl border ${isSelected ? 'border-indigo-500' : 'border-slate-700'} overflow-hidden ${ring}`}>
      {/* Group header */}
      <div
        className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none ${
          isSelected ? 'bg-indigo-500/10' : 'bg-slate-900 hover:bg-slate-800/60'
        }`}
        onClick={() => onSelect(node.id)}
      >
        <span {...dragHandleProps} className="cursor-grab text-slate-600 hover:text-slate-400 touch-none">⠿</span>
        <span className="text-slate-400">◧</span>
        <span className="flex-1 text-sm text-white font-medium">{node.label || 'Bez nazwy'}</span>
        <span className="text-xs text-slate-500">{node.children.length} elem.</span>
        <DeleteBtn onClick={() => onDelete(node.id)} />
      </div>

      {/* Group children — nested DnD */}
      <div
        ref={setDropRef}
        className={`bg-slate-950/60 transition-colors ${isOver && node.children.length === 0 ? 'bg-indigo-500/10' : ''}`}
      >
        {node.children.length > 0 ? (
          <SortableContext
            id={node.id}
            items={node.children.map((n) => n.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="px-3 py-2 space-y-1.5">
              {node.children.map((child) => (
                <SortableNode
                  key={child.id}
                  node={child}
                  monitors={monitors}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  onUpdate={onUpdate}
                  onAddToGroup={onAddToGroup}
                />
              ))}
            </div>
          </SortableContext>
        ) : (
          <div
            className={`mx-3 my-2 rounded-lg border-2 border-dashed py-4 text-center text-xs transition-colors ${
              isOver ? 'border-indigo-500 text-indigo-400 bg-indigo-500/10' : 'border-slate-700 text-slate-600'
            }`}
          >
            Przeciągnij monitor tutaj lub kliknij monitor w toolboxie gdy ta grupa jest zaznaczona
          </div>
        )}
      </div>
    </div>
  )
}

// ── Drag overlay preview ──────────────────────────────────────────────────────

function DragPreview({ node, monitors }: { node: LayoutNode; monitors: Monitor[] }) {
  if (node.type === 'monitor') {
    const n = node as MonitorNode
    const monitor = monitors.find((m) => m.id === n.monitorId)
    return (
      <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-indigo-500 bg-slate-900 shadow-lg shadow-black/40 opacity-95">
        <span className="text-xs uppercase text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">
          {monitor?.type ?? '?'}
        </span>
        <span className="text-sm text-white">{monitor?.name ?? `#${n.monitorId}`}</span>
      </div>
    )
  }
  if (node.type === 'group') {
    const n = node as GroupNode
    return (
      <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-indigo-500 bg-slate-900 shadow-lg shadow-black/40 opacity-95">
        <span className="text-slate-400">◧</span>
        <span className="text-sm text-white font-medium">{n.label}</span>
      </div>
    )
  }
  return (
    <div className="px-3 py-2.5 rounded-lg border border-indigo-500 bg-slate-900 shadow-lg opacity-95 text-sm text-slate-300">
      Element
    </div>
  )
}

// ── Properties panel ──────────────────────────────────────────────────────────

function PropertiesPanel({
  node,
  monitors,
  onUpdate,
  onAddToGroup,
}: {
  node: LayoutNode
  monitors: Monitor[]
  onUpdate: (id: string, patch: Partial<LayoutNode>) => void
  onAddToGroup: (groupId: string, node: Omit<LayoutNode, 'id'>) => void
}) {
  const inputCls =
    'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-indigo-500'

  if (node.type === 'text') {
    const n = node as TextNode
    return (
      <div className="space-y-3">
        <p className="text-xs text-slate-400 uppercase tracking-wider">Blok tekstowy</p>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Treść (Markdown)</label>
          <textarea
            value={n.markdown}
            onChange={(e) => onUpdate(node.id, { markdown: e.target.value } as Partial<TextNode>)}
            rows={10}
            className={`${inputCls} resize-none font-mono text-xs`}
          />
        </div>
      </div>
    )
  }

  if (node.type === 'monitor') {
    const n = node as MonitorNode
    return (
      <div className="space-y-3">
        <p className="text-xs text-slate-400 uppercase tracking-wider">Monitor</p>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Wybierz monitor</label>
          <select
            value={n.monitorId}
            onChange={(e) => onUpdate(node.id, { monitorId: Number(e.target.value) } as Partial<MonitorNode>)}
            className={inputCls}
          >
            {monitors.map((m) => (
              <option key={m.id} value={m.id}>
                [{m.type.toUpperCase()}] {m.name}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={n.showUptimeBar}
            onChange={(e) => onUpdate(node.id, { showUptimeBar: e.target.checked } as Partial<MonitorNode>)}
            className="accent-indigo-500"
          />
          Wykres uptime
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={n.showResponseTime}
            onChange={(e) => onUpdate(node.id, { showResponseTime: e.target.checked } as Partial<MonitorNode>)}
            className="accent-indigo-500"
          />
          Czas odpowiedzi
        </label>
      </div>
    )
  }

  if (node.type === 'group') {
    const n = node as GroupNode
    return (
      <div className="space-y-3">
        <p className="text-xs text-slate-400 uppercase tracking-wider">Grupa</p>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Nazwa grupy</label>
          <input
            value={n.label}
            onChange={(e) => onUpdate(node.id, { label: e.target.value } as Partial<GroupNode>)}
            className={inputCls}
            placeholder="Np. Polska"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={n.collapsible}
            onChange={(e) => onUpdate(node.id, { collapsible: e.target.checked } as Partial<GroupNode>)}
            className="accent-indigo-500"
          />
          Zwijalna
        </label>
        <div>
          <p className="text-xs text-slate-400 mb-2">Dodaj monitor do grupy</p>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {monitors.map((m) => (
              <button
                key={m.id}
                onClick={() => onAddToGroup(node.id, createMonitorNode(m.id))}
                className="w-full text-left text-xs text-slate-300 hover:text-white px-2 py-1.5 rounded hover:bg-slate-800 transition-colors flex items-center gap-2"
              >
                <span className="text-slate-500 uppercase text-[10px]">{m.type}</span>
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function DeleteBtn({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onClick(e)
      }}
      className="text-slate-600 hover:text-red-400 transition-colors ml-1 shrink-0"
    >
      ×
    </button>
  )
}
