import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Action } from '@bsp/shared'
import { Link } from 'react-router-dom'
import { deliveryHistoryUrl } from '../deliveryHistoryUrl'
import ActionFormModal from '../components/actions/ActionFormModal'
import { ConfirmModal } from '@better-kit/ui'
import { DataTable, DataTh, useTableSort } from '@better-kit/ui'
import { Alert, EmptyTableRow, ErrorState, LoadingState, PageContainer, PageHeader, useToast } from '@better-kit/ui'

export default function ActionsPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const [editing, setEditing]             = useState<Action | null>(null)
  const [showCreate, setShowCreate]       = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<Action | null>(null)

  const { data: actions = [], isLoading, isError, refetch } = useQuery<Action[]>({
    queryKey: ['actions'],
    queryFn: () => api.get('/admin/actions'),
  })
  const { rows: sortedActions, sort } = useTableSort(actions, {
    name: (a) => a.name,
    request: (a) => `${a.config.method} ${a.config.url}`,
    status: (a) => a.enabled,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/actions/${id}`),
    onSuccess: () => {
      toast.success('Action deleted.')
      setConfirmDelete(null)
      qc.invalidateQueries({ queryKey: ['actions'] })
      qc.invalidateQueries({ queryKey: ['action-runs'] })
    },
    onError: (err) => {
      setConfirmDelete(null)
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to delete action')
    },
  })

  function handleSaved() {
    toast.success(editing ? 'Action saved.' : 'Action created.')
    qc.invalidateQueries({ queryKey: ['actions'] })
    setEditing(null)
    setShowCreate(false)
  }

  return (
    <PageContainer>
      <PageHeader
        title="Actions"
        subtitle="HTTP requests sent when a monitor stays down or comes back up"
        actions={<>
          <Link to={deliveryHistoryUrl('actions')} className="btn btn-secondary">
            <span className="material-symbols-outlined" aria-hidden="true">history</span>
            Run history
          </Link>
          <button type="button" onClick={() => setShowCreate(true)} className="btn btn-primary">
            <span className="material-symbols-outlined" aria-hidden="true">add</span>
            Add Action
          </button>
        </>}
      />

      <Alert tone="info">
        Create actions here, then link them to a monitor in the monitor&apos;s edit form (Actions tab). There you choose the status that
        triggers the action, how long the monitor must stay in it first, and a cooldown. Unlike notifications, an action changes
        something outside BetterStatusPage, for example by starting a failover job.
      </Alert>

      {isLoading ? (
        <LoadingState label="Loading actions…" />
      ) : isError ? (
        <ErrorState message="Could not load actions." onRetry={() => void refetch()} />
      ) : (
        <div className="rounded-2xl overflow-x-auto" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          <DataTable sort={sort} className="w-full min-w-[640px] text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
                {['Name', 'Request', 'Status', ''].map((h) => (
                  <DataTh key={h} resizable={h !== ''} {...(h !== '' && { sortKey: h.toLowerCase() })}
                    className={`px-4 py-3 font-mono text-xs uppercase tracking-wider ${h === '' ? 'text-right' : 'text-left'}`}
                    style={{ color: 'var(--m3-secondary)', background: 'var(--m3-surface-container)' }}
                  >{h === '' ? <span className="sr-only">Actions</span> : h}</DataTh>
                ))}
              </tr>
            </thead>
            <tbody>
              {actions.length === 0 && <EmptyTableRow colSpan={4} icon="bolt" title="No actions yet" description="Add an action to send an HTTP request when a monitor goes down or recovers." />}
              {sortedActions.map((action, i) => (
                <tr key={action.id} style={{ borderTop: i > 0 ? '1px solid var(--m3-outline-variant)' : 'none' }}>
                  <td className="px-4 py-3 font-medium" style={{ color: 'var(--m3-on-surface)' }}>{action.name}</td>
                  <td className="px-4 py-3 font-mono text-xs max-w-xs truncate" style={{ color: 'var(--m3-secondary)' }}>
                    {action.config.method} {action.config.url}
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-1 text-xs font-medium w-fit" style={{ color: action.enabled ? 'var(--m3-up)' : 'var(--m3-secondary)' }}>
                      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: action.enabled ? 'var(--m3-up-bar)' : 'var(--m3-outline-variant)' }} />
                      {action.enabled ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button type="button" className="btn-icon w-8 h-8" title="Edit" aria-label={`Edit ${action.name}`} onClick={() => setEditing(action)}>
                        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>edit</span>
                      </button>
                      <button type="button" className="btn-icon w-8 h-8" title="Delete" aria-label={`Delete ${action.name}`} onClick={() => setConfirmDelete(action)}>
                        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>delete</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </div>
      )}

      {(showCreate || editing) && (
        <ActionFormModal action={editing} onClose={() => { setShowCreate(false); setEditing(null) }} onSaved={handleSaved} />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete action"
          message={`Delete "${confirmDelete.name}"? It is removed from all monitors and its waiting runs are cancelled.`}
          confirmLabel="Delete"
          pending={deleteMutation.isPending}
          pendingLabel="Deleting…"
          onConfirm={() => deleteMutation.mutate(confirmDelete.id)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </PageContainer>
  )
}
