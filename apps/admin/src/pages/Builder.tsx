import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { api } from '../api/client'
import { useBuilderStore, createMonitorNode, createGroupNode } from '../components/builder/useBuilderStore'
import type { Monitor, MonitorGroup, LayoutNode, GroupNode, MonitorNode, TextNode } from '@bsp/shared'

export default function BuilderPage() {
  const { tree, setTree, isDirty, markClean, addNode, deleteNode, moveNode, updateNode, selectNode, selectedId } = useBuilderStore()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const { data: monitors = [] } = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
  })

  const { data: groups = [] } = useQuery<MonitorGroup[]>({
    queryKey: ['groups'],
    queryFn: () => api.get('/admin/groups'),
  })

  // Load layout on mount
  useEffect(() => {
    api.get<{ id: string; type: string; children: LayoutNode[] }>('/admin/layout').then((data) => {
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

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    // Find both in root children and swap
    const rootChildren = tree.children
    const oldIdx = rootChildren.findIndex((n) => n.id === active.id)
    const newIdx = rootChildren.findIndex((n) => n.id === over.id)
    if (oldIdx !== -1 && newIdx !== -1) {
      const reordered = arrayMove(rootChildren, oldIdx, newIdx)
      setTree({ ...tree, children: reordered })
    }
  }

  const selectedNode = selectedId
    ? findNodeById(tree.children, selectedId)
    : null

  return (
    <div className="flex h-full">
      {/* Toolbox sidebar */}
      <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col">
        <div className="p-4 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-white">Toolbox</h3>
          <p className="text-xs text-slate-500 mt-0.5">Drag items to the canvas</p>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {/* Groups */}
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Groups</p>
            <div className="space-y-1">
              {groups.map((group) => (
                <button
                  key={group.id}
                  onClick={() => addNode('root', createGroupNode(group.id, group.name))}
                  className="w-full flex items-center gap-2 text-left text-sm text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg px-3 py-2 transition-colors"
                >
                  <span className="text-slate-500">◧</span>
                  {group.name}
                </button>
              ))}
              {groups.length === 0 && <p className="text-xs text-slate-600">No groups yet</p>}
            </div>
          </div>

          {/* Monitors */}
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Monitors</p>
            <div className="space-y-1">
              {monitors.map((monitor) => (
                <button
                  key={monitor.id}
                  onClick={() => addNode('root', createMonitorNode(monitor.id))}
                  className="w-full flex items-center gap-2 text-left text-sm text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg px-3 py-2 transition-colors"
                >
                  <span className="text-xs text-slate-500 uppercase bg-slate-700 px-1 rounded">{monitor.type}</span>
                  {monitor.name}
                </button>
              ))}
              {monitors.length === 0 && <p className="text-xs text-slate-600">No monitors yet</p>}
            </div>
          </div>

          {/* Blocks */}
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Blocks</p>
            <div className="space-y-1">
              <button
                onClick={() => addNode('root', { id: '', type: 'text', markdown: '# Section Title\nAdd your description here.' } as TextNode)}
                className="w-full flex items-center gap-2 text-left text-sm text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg px-3 py-2 transition-colors"
              >
                <span className="text-slate-500">T</span>
                Text Block
              </button>
              <button
                onClick={() => addNode('root', { id: '', type: 'divider' })}
                className="w-full flex items-center gap-2 text-left text-sm text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg px-3 py-2 transition-colors"
              >
                <span className="text-slate-500">—</span>
                Divider
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Canvas */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div>
            <h2 className="text-lg font-semibold text-white">Page Builder</h2>
            <p className="text-xs text-slate-500 mt-0.5">Click to select, drag to reorder</p>
          </div>
          <div className="flex items-center gap-3">
            {isDirty && <span className="text-xs text-amber-400">Unsaved changes</span>}
            {saved && <span className="text-xs text-emerald-400">Saved!</span>}
            <button
              onClick={handleSave}
              disabled={saving || !isDirty}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              {saving ? 'Saving…' : 'Save Layout'}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {tree.children.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 border-2 border-dashed border-slate-700 rounded-xl text-slate-500">
              <p className="text-lg">Empty canvas</p>
              <p className="text-sm mt-1">Click items from the toolbox to add them</p>
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={tree.children.map((n) => n.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                  {tree.children.map((node) => (
                    <SortableCanvasNode
                      key={node.id}
                      node={node}
                      monitors={monitors}
                      groups={groups}
                      selectedId={selectedId}
                      onSelect={selectNode}
                      onDelete={deleteNode}
                      onUpdate={updateNode}
                      onAddToGroup={(parentId, n) => addNode(parentId, n)}
                      onMoveInGroup={moveNode}
                      allMonitors={monitors}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </div>

      {/* Properties panel */}
      {selectedNode && (
        <aside className="w-72 bg-slate-900 border-l border-slate-800 flex flex-col">
          <div className="p-4 border-b border-slate-800 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Properties</h3>
            <button onClick={() => selectNode(null)} className="text-slate-400 hover:text-white text-lg leading-none">×</button>
          </div>
          <div className="p-4">
            <PropertiesPanel node={selectedNode} monitors={monitors} groups={groups} onUpdate={updateNode} />
          </div>
        </aside>
      )}
    </div>
  )
}

function findNodeById(children: LayoutNode[], id: string): LayoutNode | null {
  for (const child of children) {
    if (child.id === id) return child
    if (child.type === 'group') {
      const found = findNodeById((child as GroupNode).children, id)
      if (found) return found
    }
  }
  return null
}

interface CanvasNodeProps {
  node: LayoutNode
  monitors: Monitor[]
  groups: MonitorGroup[]
  selectedId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onUpdate: (id: string, patch: Partial<LayoutNode>) => void
  onAddToGroup: (parentId: string, node: LayoutNode) => void
  onMoveInGroup: (nodeId: string, parentId: string, index: number) => void
  allMonitors: Monitor[]
}

function SortableCanvasNode(props: CanvasNodeProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.node.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style}>
      <CanvasNodeRenderer {...props} dragHandleProps={{ ...attributes, ...listeners }} />
    </div>
  )
}

function CanvasNodeRenderer({
  node,
  monitors,
  groups,
  selectedId,
  onSelect,
  onDelete,
  onUpdate,
  onAddToGroup,
  allMonitors,
  dragHandleProps,
}: CanvasNodeProps & { dragHandleProps: object }) {
  const isSelected = selectedId === node.id

  if (node.type === 'divider') {
    return (
      <div
        className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${isSelected ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-700 hover:border-slate-600'}`}
        onClick={() => onSelect(node.id)}
      >
        <span {...dragHandleProps} className="cursor-grab text-slate-600 hover:text-slate-400">⠿</span>
        <hr className="flex-1 border-slate-600" />
        <span className="text-xs text-slate-500">Divider</span>
        <button onClick={(e) => { e.stopPropagation(); onDelete(node.id) }} className="text-slate-600 hover:text-red-400 ml-2">×</button>
      </div>
    )
  }

  if (node.type === 'text') {
    const textNode = node as TextNode
    return (
      <div
        className={`rounded-lg border cursor-pointer transition-colors ${isSelected ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-700 hover:border-slate-600 bg-slate-900'}`}
        onClick={() => onSelect(node.id)}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-700/50">
          <span {...dragHandleProps} className="cursor-grab text-slate-600 hover:text-slate-400">⠿</span>
          <span className="text-xs text-slate-400 flex-1">Text Block</span>
          <button onClick={(e) => { e.stopPropagation(); onDelete(node.id) }} className="text-slate-600 hover:text-red-400">×</button>
        </div>
        <div className="px-3 py-2">
          <p className="text-sm text-slate-300 line-clamp-2">{textNode.markdown}</p>
        </div>
      </div>
    )
  }

  if (node.type === 'monitor') {
    const monNode = node as MonitorNode
    const monitor = monitors.find((m) => m.id === monNode.monitorId)
    return (
      <div
        className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors ${isSelected ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-700 hover:border-slate-600 bg-slate-900'}`}
        onClick={() => onSelect(node.id)}
      >
        <span {...dragHandleProps} className="cursor-grab text-slate-600 hover:text-slate-400">⠿</span>
        <span className="text-xs uppercase text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">
          {monitor?.type ?? '?'}
        </span>
        <span className="flex-1 text-sm text-white">{monitor?.name ?? `Monitor #${monNode.monitorId}`}</span>
        <button onClick={(e) => { e.stopPropagation(); onDelete(node.id) }} className="text-slate-600 hover:text-red-400">×</button>
      </div>
    )
  }

  if (node.type === 'group') {
    const groupNode = node as GroupNode
    const group = groups.find((g) => g.id === groupNode.groupId)
    return (
      <div className={`rounded-lg border transition-colors ${isSelected ? 'border-indigo-500' : 'border-slate-700'}`}>
        <div
          className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer ${isSelected ? 'bg-indigo-500/10' : 'bg-slate-900 hover:bg-slate-800/50'} rounded-t-lg`}
          onClick={() => onSelect(node.id)}
        >
          <span {...dragHandleProps} className="cursor-grab text-slate-600 hover:text-slate-400">⠿</span>
          <span className="text-slate-500">◧</span>
          <span className="flex-1 text-sm text-white font-medium">
            {groupNode.label ?? group?.name ?? `Group #${groupNode.groupId}`}
          </span>
          <span className="text-xs text-slate-500">{groupNode.children.length} items</span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              // Add a monitor to the group
              const monitor = allMonitors[0]
              if (monitor) onAddToGroup(groupNode.id, createMonitorNode(monitor.id))
            }}
            className="text-xs text-slate-400 hover:text-white px-2 py-0.5 rounded hover:bg-slate-700"
          >
            + Add
          </button>
          <button onClick={(e) => { e.stopPropagation(); onDelete(node.id) }} className="text-slate-600 hover:text-red-400">×</button>
        </div>
        {groupNode.children.length > 0 && (
          <div className="px-3 pb-3 pt-2 bg-slate-950/50 rounded-b-lg space-y-1.5">
            {groupNode.children.map((child) => (
              <CanvasNodeRenderer
                key={child.id}
                node={child}
                monitors={monitors}
                groups={groups}
                selectedId={selectedId}
                onSelect={onSelect}
                onDelete={onDelete}
                onUpdate={onUpdate}
                onAddToGroup={onAddToGroup}
                onMoveInGroup={() => {}}
                allMonitors={allMonitors}
                dragHandleProps={{}}
              />
            ))}
          </div>
        )}
        {groupNode.children.length === 0 && (
          <div className="px-3 pb-3 pt-2 bg-slate-950/50 rounded-b-lg">
            <p className="text-xs text-slate-600 text-center py-2">Empty group — add monitors from the toolbox or click "+ Add"</p>
          </div>
        )}
      </div>
    )
  }

  return null
}


function PropertiesPanel({
  node,
  monitors,
  groups,
  onUpdate,
}: {
  node: LayoutNode
  monitors: Monitor[]
  groups: MonitorGroup[]
  onUpdate: (id: string, patch: Partial<LayoutNode>) => void
}) {
  const inputCls = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-indigo-500'

  if (node.type === 'text') {
    const textNode = node as TextNode
    return (
      <div className="space-y-3">
        <p className="text-xs text-slate-400 uppercase tracking-wider">Text Block</p>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Markdown Content</label>
          <textarea
            value={textNode.markdown}
            onChange={(e) => onUpdate(node.id, { markdown: e.target.value } as Partial<TextNode>)}
            rows={8}
            className={`${inputCls} resize-none`}
          />
        </div>
      </div>
    )
  }

  if (node.type === 'monitor') {
    const monNode = node as MonitorNode
    return (
      <div className="space-y-3">
        <p className="text-xs text-slate-400 uppercase tracking-wider">Monitor</p>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Monitor</label>
          <select
            value={monNode.monitorId}
            onChange={(e) => onUpdate(node.id, { monitorId: Number(e.target.value) } as Partial<MonitorNode>)}
            className={inputCls}
          >
            {monitors.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={monNode.showUptimeBar}
            onChange={(e) => onUpdate(node.id, { showUptimeBar: e.target.checked } as Partial<MonitorNode>)}
            className="accent-indigo-500"
          />
          Show uptime bar
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={monNode.showResponseTime}
            onChange={(e) => onUpdate(node.id, { showResponseTime: e.target.checked } as Partial<MonitorNode>)}
            className="accent-indigo-500"
          />
          Show response time
        </label>
      </div>
    )
  }

  if (node.type === 'group') {
    const groupNode = node as GroupNode
    return (
      <div className="space-y-3">
        <p className="text-xs text-slate-400 uppercase tracking-wider">Group Block</p>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Group</label>
          <select
            value={groupNode.groupId}
            onChange={(e) => onUpdate(node.id, { groupId: Number(e.target.value) } as Partial<GroupNode>)}
            className={inputCls}
          >
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Label Override</label>
          <input
            value={groupNode.label ?? ''}
            onChange={(e) => onUpdate(node.id, { label: e.target.value || undefined } as Partial<GroupNode>)}
            className={inputCls}
            placeholder="(uses group name)"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={groupNode.collapsible}
            onChange={(e) => onUpdate(node.id, { collapsible: e.target.checked } as Partial<GroupNode>)}
            className="accent-indigo-500"
          />
          Collapsible
        </label>
        <div>
          <p className="text-xs text-slate-400 mb-2">Add monitor to group</p>
          {monitors.map((m) => (
            <button
              key={m.id}
              onClick={() => {
                useBuilderStore.getState().addNode(node.id, createMonitorNode(m.id))
              }}
              className="w-full text-left text-xs text-slate-300 hover:text-white px-2 py-1 rounded hover:bg-slate-800 transition-colors"
            >
              + {m.name}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return <p className="text-xs text-slate-500">No properties for this block.</p>
}
