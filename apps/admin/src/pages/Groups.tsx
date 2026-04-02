import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { MonitorGroup, Monitor } from '@bsp/shared'

export default function GroupsPage() {
  const qc = useQueryClient()
  const [newName, setNewName] = useState('')
  const [newParentId, setNewParentId] = useState<number | ''>('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')

  const { data: groups = [] } = useQuery<MonitorGroup[]>({
    queryKey: ['groups'],
    queryFn: () => api.get('/admin/groups'),
  })

  const { data: monitors = [] } = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
  })

  const createMutation = useMutation({
    mutationFn: (body: { name: string; parentId?: number }) => api.post('/admin/groups', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groups'] })
      setNewName('')
      setNewParentId('')
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api.patch(`/admin/groups/${id}`, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groups'] })
      setEditingId(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/groups/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups'] }),
  })

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const body: { name: string; parentId?: number } = { name: newName }
    if (newParentId !== '') body.parentId = newParentId
    createMutation.mutate(body)
  }

  const topLevel = groups.filter((g) => !g.parentId)

  return (
    <div className="p-8 space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white">Groups</h2>
        <p className="text-slate-400 text-sm mt-1">Organize monitors into nested groups</p>
      </div>

      {/* Create form */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h3 className="text-sm font-medium text-white mb-4">Create Group</h3>
        <form onSubmit={handleCreate} className="flex gap-3">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Group name"
            required
            className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500"
          />
          <select
            value={newParentId}
            onChange={(e) => setNewParentId(e.target.value === '' ? '' : Number(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500"
          >
            <option value="">No parent (top level)</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
          <button
            type="submit"
            className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Create
          </button>
        </form>
      </div>

      {/* Group tree */}
      <div className="space-y-2">
        {topLevel.map((group) => (
          <GroupRow
            key={group.id}
            group={group}
            groups={groups}
            monitors={monitors}
            editingId={editingId}
            editName={editName}
            onEdit={(g) => { setEditingId(g.id); setEditName(g.name) }}
            onEditName={setEditName}
            onSaveEdit={() => updateMutation.mutate({ id: editingId!, name: editName })}
            onCancelEdit={() => setEditingId(null)}
            onDelete={(id) => {
              if (confirm('Delete group? Monitors inside will be ungrouped.')) {
                deleteMutation.mutate(id)
              }
            }}
            depth={0}
          />
        ))}
        {topLevel.length === 0 && (
          <div className="text-slate-500 text-sm text-center py-8">No groups yet.</div>
        )}
      </div>
    </div>
  )
}

interface GroupRowProps {
  group: MonitorGroup
  groups: MonitorGroup[]
  monitors: Monitor[]
  editingId: number | null
  editName: string
  onEdit: (g: MonitorGroup) => void
  onEditName: (name: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onDelete: (id: number) => void
  depth: number
}

function GroupRow({ group, groups, monitors, editingId, editName, onEdit, onEditName, onSaveEdit, onCancelEdit, onDelete, depth }: GroupRowProps) {
  const children = groups.filter((g) => g.parentId === group.id)
  const groupMonitors = monitors.filter((m) => m.groupId === group.id)
  const isEditing = editingId === group.id

  return (
    <div style={{ marginLeft: depth * 20 }}>
      <div className="bg-slate-900 border border-slate-800 rounded-lg px-4 py-3 flex items-center gap-3">
        <span className="text-slate-500">{'▸ '.repeat(depth)}◧</span>
        {isEditing ? (
          <div className="flex-1 flex gap-2">
            <input
              value={editName}
              onChange={(e) => onEditName(e.target.value)}
              className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white text-sm focus:outline-none focus:border-indigo-500"
              autoFocus
            />
            <button onClick={onSaveEdit} className="text-sm text-indigo-400 hover:text-indigo-300">Save</button>
            <button onClick={onCancelEdit} className="text-sm text-slate-400 hover:text-white">Cancel</button>
          </div>
        ) : (
          <>
            <span className="flex-1 text-white font-medium">{group.name}</span>
            <span className="text-xs text-slate-500">{groupMonitors.length} monitor{groupMonitors.length !== 1 ? 's' : ''}</span>
            <button onClick={() => onEdit(group)} className="text-xs text-slate-400 hover:text-white px-2 py-1 rounded hover:bg-slate-800">Edit</button>
            <button onClick={() => onDelete(group.id)} className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-red-500/10">Delete</button>
          </>
        )}
      </div>
      {children.map((child) => (
        <GroupRow key={child.id} group={child} groups={groups} monitors={monitors} editingId={editingId} editName={editName} onEdit={onEdit} onEditName={onEditName} onSaveEdit={onSaveEdit} onCancelEdit={onCancelEdit} onDelete={onDelete} depth={depth + 1} />
      ))}
    </div>
  )
}
