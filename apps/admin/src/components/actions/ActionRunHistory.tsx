import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { Action, ActionRun, ActionRunStatus } from '@bsp/shared'
import { EmptyStateLink, EmptyTableRow, ErrorState, LoadingState, Pagination } from '../ui'
import { formatDateTime } from '../../lib/dateFormat'

interface RunListResponse {
  runs: ActionRun[]
  total: number
  page: number
  pages: number
}

const STATUS_LABEL: Record<ActionRunStatus, string> = {
  pending: 'Pending',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const STATUS_COLOR: Record<ActionRunStatus, string> = {
  pending: 'var(--m3-degraded-bar)',
  succeeded: 'var(--m3-up-bar)',
  failed: 'var(--m3-error)',
  cancelled: 'var(--m3-outline)',
}

/** The runs of every action, newest first; the Actions tab of the delivery history. */
export function ActionRunHistory() {
  const [page, setPage]         = useState(1)
  const [status, setStatus]     = useState('')
  const [actionId, setActionId] = useState('')

  const { data: actions = [] } = useQuery<Action[]>({
    queryKey: ['actions'],
    queryFn: () => api.get('/admin/actions'),
  })

  const params = new URLSearchParams({ page: String(page), limit: '20' })
  if (status) params.set('status', status)
  if (actionId) params.set('actionId', actionId)
  const { data, isLoading, isError, refetch } = useQuery<RunListResponse>({
    queryKey: ['action-runs', page, status, actionId],
    queryFn: () => api.get(`/admin/actions/runs?${params}`),
    refetchInterval: 30_000,
  })

  function changeFilter(setter: (value: string) => void, value: string) {
    setter(value)
    setPage(1)
  }

  const filtered = !!(status || actionId)

  return <section className="space-y-4 pt-2">
    <div className="overflow-x-auto pb-1">
      <div className="grid grid-cols-2 gap-2 min-w-[420px] max-w-xl">
        <select aria-label="Status" className="input-sig text-sm min-w-32" value={status} onChange={(e) => changeFilter(setStatus, e.target.value)}>
          <option value="">All statuses</option>
          {(Object.keys(STATUS_LABEL) as ActionRunStatus[]).map((key) => <option key={key} value={key}>{STATUS_LABEL[key]}</option>)}
        </select>
        <select aria-label="Action" className="input-sig text-sm min-w-40" value={actionId} onChange={(e) => changeFilter(setActionId, e.target.value)}>
          <option value="">All actions</option>
          {actions.map((action) => <option key={action.id} value={action.id}>{action.name}</option>)}
        </select>
      </div>
    </div>

    <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
      {isLoading ? <LoadingState label="Loading runs…" />
        : isError ? <ErrorState message="Could not load action runs." onRetry={() => void refetch()} className="rounded-none" />
          : <div className="overflow-x-auto"><table className="w-full text-sm min-w-[850px]">
            <thead><tr style={{ background: 'var(--m3-surface-container)', borderBottom: '1px solid var(--m3-outline-variant)' }}>
              {['Time', 'Monitor', 'Action', 'Attempts', 'Status', 'Details'].map((label) => (
                <th key={label} className="px-4 py-3 text-left font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>{label}</th>
              ))}
            </tr></thead>
            <tbody>
              {data?.runs.map((run, i) => (
                <tr key={run.id} style={{ borderTop: i > 0 ? '1px solid var(--m3-outline-variant)' : 'none' }}>
                  <td className="px-4 py-3 text-xs whitespace-nowrap" style={{ color: 'var(--m3-secondary)' }}>{formatDateTime(run.createdAt)}</td>
                  <td className="px-4 py-3 font-medium" style={{ color: 'var(--m3-on-surface)' }}>{run.monitorName}</td>
                  <td className="px-4 py-3" style={{ color: 'var(--m3-on-surface)' }}>
                    {run.actionName}
                    <span className="block text-xs" style={{ color: 'var(--m3-secondary)' }}>when {run.onStatus === 'up' ? 'back up' : 'down'}</span>
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--m3-secondary)' }}>{run.attemptCount}/{run.maxAttempts}</td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-1.5 text-xs font-medium w-fit" style={{ color: 'var(--m3-on-surface)' }}>
                      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: STATUS_COLOR[run.status] }} />
                      {STATUS_LABEL[run.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--m3-secondary)' }}>
                    {run.status === 'pending' && run.nextAttemptAt !== null && <span className="block">Next attempt {formatDateTime(run.nextAttemptAt)}</span>}
                    {run.lastError && <span className="block break-words">{run.lastError}</span>}
                  </td>
                </tr>
              ))}
              {!data?.runs.length && (filtered
                ? <EmptyTableRow colSpan={6} icon="bolt" title="No runs match these filters." description={<><EmptyStateLink onClick={() => { setStatus(''); setActionId(''); setPage(1) }}>Clear the filters</EmptyStateLink> to see every run.</>} />
                : <EmptyTableRow colSpan={6} icon="bolt" title="No runs yet" description="Actions run when a monitor stays down or comes back up, and are listed here." />)}
            </tbody>
          </table></div>}
    </div>
    {data && <Pagination page={page} pageCount={data.pages} onPageChange={setPage} summary={`Page ${page} of ${data.pages} · ${data.total} runs`} />}
  </section>
}
