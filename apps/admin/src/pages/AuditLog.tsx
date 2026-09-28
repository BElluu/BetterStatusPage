import { useId, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { EmptyState, ErrorState, LoadingState, PageContainer, PageHeader, Pagination } from '../components/ui'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import type { AuditLogEntry, AuditAction, AuditEntityType } from '@bsp/shared'

interface AuditPage {
  entries: AuditLogEntry[]
  total: number
  page: number
  limit: number
  pages: number
}

const ACTION_COLORS: Record<AuditAction, { bg: string; color: string; label: string }> = {
  create: { bg: 'var(--audit-create-bg)', color: 'var(--audit-create-text)', label: 'Create' },
  update: { bg: 'var(--audit-update-bg)', color: 'var(--audit-update-text)', label: 'Update' },
  delete: { bg: 'var(--audit-delete-bg)', color: 'var(--audit-delete-text)', label: 'Delete' },
}

const ENTITY_LABELS: Record<AuditEntityType, string> = {
  monitor:              'Monitor',
  incident:             'Incident',
  maintenance:          'Maintenance',
  notification_channel: 'Notification Channel',
  smtp_settings:        'SMTP Settings',
  subscription_settings: 'Subscription Settings',
  subscriber:           'Subscriber',
  vault:                'Vault',
  vault_secret:         'Vault Secret',
  user:                 'User',
}

const ENTITY_ICONS: Record<AuditEntityType, string> = {
  monitor:              'radio_button_checked',
  incident:             'warning',
  maintenance:          'construction',
  notification_channel: 'notifications',
  smtp_settings:        'email',
  subscription_settings: 'campaign',
  subscriber:           'person_add',
  vault:                'shield_lock',
  vault_secret:         'key',
  user:                 'person',
}

function formatTs(ms: number) {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function DiffView({ diff }: { diff: Record<string, unknown> }) {
  const entries = Object.entries(diff)
  if (entries.length === 0) return <span style={{ color: 'var(--m3-outline)' }}>—</span>

  // Detect if values are {from, to} pairs (update diff) or a flat snapshot
  const isUpdateDiff = entries.every(([, v]) =>
    v !== null && typeof v === 'object' && 'from' in (v as object) && 'to' in (v as object),
  )

  if (isUpdateDiff) {
    return (
      <table style={{ borderCollapse: 'collapse', fontSize: '11px', width: '100%' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '2px 8px 2px 0', color: 'var(--m3-outline)', fontWeight: 600, whiteSpace: 'nowrap' }}>Field</th>
            <th style={{ textAlign: 'left', padding: '2px 8px', color: 'var(--m3-outline)', fontWeight: 600 }}>Before</th>
            <th style={{ textAlign: 'left', padding: '2px 0', color: 'var(--m3-outline)', fontWeight: 600 }}>After</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, val]) => {
            const { from, to } = val as { from: unknown; to: unknown }
            return (
              <tr key={key}>
                <td style={{ padding: '2px 8px 2px 0', color: 'var(--m3-secondary)', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{key}</td>
                <td style={{ padding: '2px 8px', verticalAlign: 'top' }}>
                  <span style={{ color: 'var(--audit-delete-text)', background: 'var(--audit-delete-bg)', borderRadius: 4, padding: '0 4px', display: 'inline-block', wordBreak: 'break-all' }}>
                    {from === null ? 'null' : String(from)}
                  </span>
                </td>
                <td style={{ padding: '2px 0', verticalAlign: 'top' }}>
                  <span style={{ color: 'var(--audit-create-text)', background: 'var(--audit-create-bg)', borderRadius: 4, padding: '0 4px', display: 'inline-block', wordBreak: 'break-all' }}>
                    {to === null ? 'null' : String(to)}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    )
  }

  // Flat snapshot (create/delete)
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
      {entries.map(([key, val]) => (
        <span key={key} style={{ fontSize: '11px' }}>
          <span style={{ color: 'var(--m3-outline)' }}>{key}: </span>
          <span style={{ color: 'var(--m3-on-surface)' }}>{val === null ? 'null' : String(val)}</span>
        </span>
      ))}
    </div>
  )
}

const GRID_COLUMNS = '168px 160px 90px 160px 1fr'
const FILTER_LABEL = 'font-mono text-[10px] uppercase tracking-widest'

export default function AuditLogPage() {
  const [page, setPage] = useState(1)
  const [emailInput, setEmailInput] = useState('')
  const [userEmail, flushEmail] = useDebouncedValue(emailInput, 300)
  const [entityType, setEntityType] = useState('')
  const [action, setAction] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate]   = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)
  const idPrefix = useId()

  // Reset to page 1 when filters change
  const filters = useMemo(() => ({
    page,
    limit: 50,
    ...(userEmail  ? { userEmail }  : {}),
    ...(entityType ? { entityType } : {}),
    ...(action     ? { action }     : {}),
    ...(fromDate   ? { from: String(new Date(fromDate).getTime()) } : {}),
    ...(toDate     ? { to: String(new Date(toDate + 'T23:59:59').getTime()) } : {}),
  }), [page, userEmail, entityType, action, fromDate, toDate])

  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, String(v)])),
  ).toString()

  const { data, isFetching, isLoading, isError, refetch } = useQuery<AuditPage>({
    queryKey: ['audit', qs],
    queryFn: () => api.get(`/admin/audit?${qs}`),
    refetchOnMount: 'always',
  })

  function clearFilters() {
    setEmailInput(''); flushEmail(''); setEntityType(''); setAction(''); setFromDate(''); setToDate(''); setPage(1)
  }

  const entries = data?.entries ?? []
  const totalPages = data?.pages ?? 1

  return (
    <PageContainer>
      <PageHeader title="Audit Log" subtitle={data ? `${data.total} entries` : undefined} />

      {/* Filters */}
      <div
        className="rounded-2xl p-4 flex flex-wrap gap-3 items-end"
        style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}
      >
        <div className="flex flex-col gap-1 min-w-[180px] flex-1">
          <label htmlFor={`${idPrefix}-user`} className={FILTER_LABEL} style={{ color: 'var(--m3-outline)' }}>User</label>
          <input
            id={`${idPrefix}-user`}
            value={emailInput}
            onChange={(e) => { setEmailInput(e.target.value); setPage(1) }}
            onKeyDown={(e) => { if (e.key === 'Enter') flushEmail() }}
            placeholder="Filter by email…"
            className="input-sig"
            style={{ height: '36px', fontSize: '13px' }}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={`${idPrefix}-entity`} className={FILTER_LABEL} style={{ color: 'var(--m3-outline)' }}>Entity</label>
          <select
            id={`${idPrefix}-entity`}
            value={entityType}
            onChange={(e) => { setEntityType(e.target.value); setPage(1) }}
            className="input-sig"
            style={{ height: '36px', fontSize: '13px', width: '180px' }}
          >
            <option value="">All entities</option>
            {(Object.keys(ENTITY_LABELS) as AuditEntityType[]).map((t) => (
              <option key={t} value={t}>{ENTITY_LABELS[t]}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={`${idPrefix}-action`} className={FILTER_LABEL} style={{ color: 'var(--m3-outline)' }}>Action</label>
          <select
            id={`${idPrefix}-action`}
            value={action}
            onChange={(e) => { setAction(e.target.value); setPage(1) }}
            className="input-sig"
            style={{ height: '36px', fontSize: '13px', width: '130px' }}
          >
            <option value="">All actions</option>
            <option value="create">Create</option>
            <option value="update">Update</option>
            <option value="delete">Delete</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={`${idPrefix}-from`} className={FILTER_LABEL} style={{ color: 'var(--m3-outline)' }}>From</label>
          <input
            id={`${idPrefix}-from`}
            type="date"
            value={fromDate}
            onChange={(e) => { setFromDate(e.target.value); setPage(1) }}
            className="input-sig"
            style={{ height: '36px', fontSize: '13px', width: '150px' }}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={`${idPrefix}-to`} className={FILTER_LABEL} style={{ color: 'var(--m3-outline)' }}>To</label>
          <input
            id={`${idPrefix}-to`}
            type="date"
            value={toDate}
            onChange={(e) => { setToDate(e.target.value); setPage(1) }}
            className="input-sig"
            style={{ height: '36px', fontSize: '13px', width: '150px' }}
          />
        </div>

        {(emailInput || entityType || action || fromDate || toDate) && (
          <button type="button" onClick={clearFilters} className="btn btn-ghost btn-sm self-end" style={{ height: '36px' }}>
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <LoadingState label="Loading audit log…" />
      ) : isError ? (
        <ErrorState message="Could not load the audit log." onRetry={() => void refetch()} />
      ) : entries.length === 0 ? (
        <EmptyState icon="history" title="No audit entries found." description="Try widening the filters or the date range." />
      ) : (
        <div
          className="rounded-2xl overflow-x-auto"
          style={{ border: '1px solid var(--m3-outline-variant)', opacity: isFetching ? 0.7 : 1, transition: 'opacity 0.15s' }}
        >
          <div className="min-w-[860px]">
            {/* Header */}
            <div
              className="grid font-mono text-[10px] uppercase tracking-widest px-5 py-2.5"
              style={{
                gridTemplateColumns: GRID_COLUMNS,
                color: 'var(--m3-outline)',
                borderBottom: '1px solid var(--m3-outline-variant)',
                background: 'var(--m3-surface-container)',
              }}
            >
              <span>Timestamp</span>
              <span>User</span>
              <span>Action</span>
              <span>Entity</span>
              <span>Details</span>
            </div>

            {entries.map((entry) => {
              const ac = ACTION_COLORS[entry.action]
              const entityLabel = ENTITY_LABELS[entry.entityType as AuditEntityType] ?? entry.entityType
              const entityIcon  = ENTITY_ICONS[entry.entityType as AuditEntityType] ?? 'article'
              const isExpanded  = expanded === entry.id
              const hasDiff     = entry.diff && Object.keys(entry.diff).length > 0
              const diffId      = `${idPrefix}-diff-${entry.id}`
              const fieldCount  = hasDiff ? Object.keys(entry.diff!).length : 0

              return (
                <div
                  key={entry.id}
                  style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}
                >
                  {/* Main row */}
                  <div
                    className="grid items-center px-5 py-3"
                    style={{ gridTemplateColumns: GRID_COLUMNS }}
                  >
                    {/* Timestamp */}
                    <span className="font-mono text-xs" style={{ color: 'var(--m3-secondary)' }}>
                      {formatTs(entry.timestamp)}
                    </span>

                    {/* User */}
                    <span className="text-sm truncate" style={{ color: 'var(--m3-on-surface)' }} title={entry.userEmail}>
                      {entry.userEmail}
                    </span>

                    {/* Action badge */}
                    <span
                      className="text-xs font-bold px-2 py-0.5 rounded-full w-fit"
                      style={{ background: ac.bg, color: ac.color }}
                    >
                      {ac.label}
                    </span>

                    {/* Entity */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="material-symbols-outlined flex-shrink-0" aria-hidden="true" style={{ fontSize: '14px', color: 'var(--m3-secondary)' }}>
                        {entityIcon}
                      </span>
                      <div className="min-w-0">
                        <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: 'var(--m3-outline)' }}>
                          {entityLabel}
                        </div>
                        <div className="text-xs truncate" style={{ color: 'var(--m3-on-surface)' }} title={entry.entityName}>
                          {entry.entityName}
                        </div>
                      </div>
                    </div>

                    {/* Details / expand */}
                    {hasDiff ? (
                      <button
                        type="button"
                        onClick={() => setExpanded(isExpanded ? null : entry.id)}
                        aria-expanded={isExpanded}
                        aria-controls={isExpanded ? diffId : undefined}
                        className="focus-ring flex items-center justify-between gap-2 min-w-0 -mx-2 px-2 py-1.5 rounded-lg text-left transition-colors hover:bg-[var(--m3-surface-container-low)]"
                      >
                        <span className="text-xs" style={{ color: 'var(--m3-secondary)' }}>
                          {isExpanded ? 'Hide details' : `${fieldCount} field${fieldCount !== 1 ? 's' : ''} changed`}
                        </span>
                        <span
                          className="material-symbols-outlined"
                          aria-hidden="true"
                          style={{
                            fontSize: '16px', color: 'var(--m3-secondary)',
                            transform: isExpanded ? 'rotate(180deg)' : 'none',
                            transition: 'transform 0.2s',
                          }}
                        >
                          expand_more
                        </span>
                      </button>
                    ) : (
                      <span className="text-xs" style={{ color: 'var(--m3-outline)' }}>—</span>
                    )}
                  </div>

                  {/* Expanded diff */}
                  {isExpanded && hasDiff && (
                    <div
                      id={diffId}
                      className="px-5 py-3"
                      style={{ borderTop: '1px solid var(--m3-outline-variant)', background: 'var(--m3-surface-container-lowest)' }}
                    >
                      <DiffView diff={entry.diff!} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <Pagination
        page={page}
        pageCount={totalPages}
        onPageChange={setPage}
        summary={`Page ${page} of ${totalPages} · ${data?.total ?? 0} entries`}
      />
    </PageContainer>
  )
}
