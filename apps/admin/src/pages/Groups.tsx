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
    <div className="p-8 space-y-6 fade-up">
      <div>
        <h1 className="font-display font-bold text-2xl" style={{ color: 'var(--sig-text)' }}>Groups</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--sig-text-muted)' }}>
          Organize monitors into nested groups · {groups.length} group{groups.length !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Create form */}
      <div className="glass rounded-xl p-5">
        <p className="font-mono text-xs uppercase tracking-wider mb-4" style={{ color: 'var(--sig-text-muted)' }}>
          Create Group
        </p>
        <form onSubmit={handleCreate} className="flex gap-3">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Group name"
            required
            className="input-sig flex-1"
          />
          <select
            value={newParentId}
            onChange={(e) => setNewParentId(e.target.value === '' ? '' : Number(e.target.value))}
            className="input-sig"
            style={{ width: 'auto', minWidth: 140 }}
          >
            <option value="">No parent (top level)</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
          <button
            type="submit"
            className="text-sm font-semibold px-4 py-2 rounded-lg flex-shrink-0 transition-all"
            style={{
              background: 'linear-gradient(135deg, #00d4af 0%, #00a88a 100%)',
              color: '#080d18',
            }}
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
          <div className="text-center py-12 text-sm" style={{ color: 'var(--sig-text-muted)' }}>
            No groups yet.
          </div>
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

const depthColors = ['var(--sig-teal)', '#f5a623', '#a78bfa', '#60a5fa']

function GroupRow({ group, groups, monitors, editingId, editName, onEdit, onEditName, onSaveEdit, onCancelEdit, onDelete, depth }: GroupRowProps) {
  const children = groups.filter((g) => g.parentId === group.id)
  const groupMonitors = monitors.filter((m) => m.groupId === group.id)
  const isEditing = editingId === group.id
  const accentColor = depthColors[depth % depthColors.length] ?? 'var(--sig-teal)'

  return (
    <div style={{ marginLeft: depth * 20 }}>
      <div
        className="glass glass-hover rounded-xl px-4 py-3 flex items-center gap-3"
        style={{ borderLeft: `2px solid ${accentColor}30` }}
      >
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: accentColor, opacity: 0.7 }} />

        {isEditing ? (
          <div className="flex-1 flex gap-2">
            <input
              value={editName}
              onChange={(e) => onEditName(e.target.value)}
              className="input-sig flex-1 py-1 text-sm"
              autoFocus
            />
            <button
              onClick={onSaveEdit}
              className="text-sm px-3 py-1 rounded-lg"
              style={{ color: 'var(--sig-teal)', background: 'var(--sig-teal-glow)' }}
            >
              Save
            </button>
            <button
              onClick={onCancelEdit}
              className="text-sm px-2"
              style={{ color: 'var(--sig-text-muted)' }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            <span className="flex-1 text-sm font-medium" style={{ color: 'var(--sig-text)' }}>
              {group.name}
            </span>
            <span className="font-mono text-xs" style={{ color: 'var(--sig-text-muted)' }}>
              {groupMonitors.length} monitor{groupMonitors.length !== 1 ? 's' : ''}
            </span>
            <button
              onClick={() => onEdit(group)}
              className="text-xs px-2 py-1 rounded transition-colors"
              style={{ color: 'var(--sig-text-muted)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--sig-text)'; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--sig-text-muted)'; (e.currentTarget as HTMLButtonElement).style.background = '' }}
            >
              Edit
            </button>
            <button
              onClick={() => onDelete(group.id)}
              className="text-xs px-2 py-1 rounded transition-colors"
              style={{ color: 'var(--sig-red)' }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,77,106,0.1)')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = '')}
            >
              Delete
            </button>
          </>
        )}
      </div>
      {children.map((child) => (
        <GroupRow
          key={child.id}
          group={child}
          groups={groups}
          monitors={monitors}
          editingId={editingId}
          editName={editName}
          onEdit={onEdit}
          onEditName={onEditName}
          onSaveEdit={onSaveEdit}
          onCancelEdit={onCancelEdit}
          onDelete={onDelete}
          depth={depth + 1}
        />
      ))}
    </div>
  )
}
