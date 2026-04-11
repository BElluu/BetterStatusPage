import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { AuditLogEntry, AuditAction, AuditEntityType } from '@bsp/shared'

interface AuditPage {
  entries: AuditLogEntry[]
  total: number
  page: number
  limit: number
  pages: number
}

const ACTION_COLORS: Record<AuditAction, { bg: string; color: string; label: string }> = {
  create: { bg: 'rgba(16,185,129,0.12)', color: '#065f46', label: 'Create' },
  update: { bg: 'rgba(99,102,241,0.12)', color: '#3730a3', label: 'Update' },
  delete: { bg: 'rgba(239,68,68,0.12)',  color: '#991b1b', label: 'Delete' },
}

const ENTITY_LABELS: Record<AuditEntityType, string> = {
  monitor:              'Monitor',
  incident:             'Incident',
  maintenance:          'Maintenance',
  notification_channel: 'Notification Channel',
  smtp_settings:        'SMTP Settings',
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
                  <span style={{ color: '#991b1b', background: 'rgba(239,68,68,0.08)', borderRadius: 4, padding: '0 4px', display: 'inline-block', wordBreak: 'break-all' }}>
                    {from === null ? 'null' : String(from)}
                  </span>
                </td>
                <td style={{ padding: '2px 0', verticalAlign: 'top' }}>
                  <span style={{ color: '#065f46', background: 'rgba(16,185,129,0.1)', borderRadius: 4, padding: '0 4px', display: 'inline-block', wordBreak: 'break-all' }}>
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

export default function AuditLogPage() {
  const [page, setPage] = useState(1)
  const [userEmail, setUserEmail] = useState('')
  const [entityType, setEntityType] = useState('')
  const [action, setAction] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate]   = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)

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

  const { data, isFetching } = useQuery<AuditPage>({
    queryKey: ['audit', qs],
    queryFn: () => api.get(`/admin/audit?${qs}`),
    refetchOnMount: 'always',
  })

  function applyFilter() { setPage(1) }

  const entries = data?.entries ?? []
  const totalPages = data?.pages ?? 1

  return (
    <div className="p-8 space-y-5 fade-up">
      {/* Header */}
      <div>
        <h1 className="font-headline font-bold text-2xl" style={{ color: 'var(--m3-on-surface)' }}>Audit Log</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>
          {data ? `${data.total} entries` : 'Loading…'}
        </p>
      </div>

      {/* Filters */}
      <div
        className="rounded-2xl p-4 flex flex-wrap gap-3 items-end"
        style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}
      >
        <div className="flex flex-col gap-1 min-w-[180px] flex-1">
          <label className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--m3-outline)' }}>User</label>
          <input
            value={userEmail}
            onChange={(e) => setUserEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyFilter()}
            placeholder="Filter by email…"
            className="input-sig"
            style={{ height: '36px', fontSize: '13px' }}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--m3-outline)' }}>Entity</label>
          <select
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
          <label className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--m3-outline)' }}>Action</label>
          <select
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
          <label className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--m3-outline)' }}>From</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => { setFromDate(e.target.value); setPage(1) }}
            className="input-sig"
            style={{ height: '36px', fontSize: '13px', width: '150px' }}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--m3-outline)' }}>To</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => { setToDate(e.target.value); setPage(1) }}
            className="input-sig"
            style={{ height: '36px', fontSize: '13px', width: '150px' }}
          />
        </div>

        {(userEmail || entityType || action || fromDate || toDate) && (
          <button
            onClick={() => { setUserEmail(''); setEntityType(''); setAction(''); setFromDate(''); setToDate(''); setPage(1) }}
            className="text-sm px-3 py-2 rounded-lg transition-colors self-end"
            style={{ color: 'var(--m3-secondary)', height: '36px' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-on-surface)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-secondary)' }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div
        className="rounded-2xl overflow-hidden"
        style={{ border: '1px solid var(--m3-outline-variant)', opacity: isFetching ? 0.7 : 1, transition: 'opacity 0.15s' }}
      >
        {/* Header */}
        <div
          className="grid font-mono text-[10px] uppercase tracking-widest px-5 py-2.5"
          style={{
            gridTemplateColumns: '168px 160px 90px 160px 1fr',
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

        {entries.length === 0 && !isFetching && (
          <div className="text-center py-14 text-sm" style={{ color: 'var(--m3-secondary)' }}>
            No audit entries found.
          </div>
        )}

        {entries.map((entry) => {
          const ac = ACTION_COLORS[entry.action]
          const entityLabel = ENTITY_LABELS[entry.entityType as AuditEntityType] ?? entry.entityType
          const entityIcon  = ENTITY_ICONS[entry.entityType as AuditEntityType] ?? 'article'
          const isExpanded  = expanded === entry.id
          const hasDiff     = entry.diff && Object.keys(entry.diff).length > 0

          return (
            <div
              key={entry.id}
              style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}
            >
              {/* Main row */}
              <div
                className="grid items-center px-5 py-3 transition-colors"
                style={{ gridTemplateColumns: '168px 160px 90px 160px 1fr', cursor: hasDiff ? 'pointer' : 'default' }}
                onClick={() => hasDiff && setExpanded(isExpanded ? null : entry.id)}
                onMouseEnter={(e) => { if (hasDiff) (e.currentTarget as HTMLDivElement).style.background = 'var(--m3-surface-container-low)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = '' }}
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
                  <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: '14px', color: 'var(--m3-secondary)' }}>
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
                <div className="flex items-center justify-between min-w-0">
                  {hasDiff ? (
                    <span className="text-xs" style={{ color: 'var(--m3-secondary)' }}>
                      {isExpanded ? 'Hide details' : `${Object.keys(entry.diff!).length} field${Object.keys(entry.diff!).length !== 1 ? 's' : ''} changed`}
                    </span>
                  ) : (
                    <span className="text-xs" style={{ color: 'var(--m3-outline)' }}>—</span>
                  )}
                  {hasDiff && (
                    <span
                      className="material-symbols-outlined"
                      style={{
                        fontSize: '16px', color: 'var(--m3-secondary)',
                        transform: isExpanded ? 'rotate(180deg)' : 'none',
                        transition: 'transform 0.2s',
                      }}
                    >
                      expand_more
                    </span>
                  )}
                </div>
              </div>

              {/* Expanded diff */}
              {isExpanded && hasDiff && (
                <div
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

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm" style={{ color: 'var(--m3-secondary)' }}>
            Page {page} of {totalPages} · {data?.total ?? 0} entries
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="text-sm px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
              style={{ color: 'var(--m3-secondary)', border: '1px solid var(--m3-outline-variant)' }}
              onMouseEnter={(e) => { if (page > 1) (e.currentTarget as HTMLButtonElement).style.background = 'var(--m3-surface-container)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '' }}
            >
              ← Prev
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="text-sm px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
              style={{ color: 'var(--m3-secondary)', border: '1px solid var(--m3-outline-variant)' }}
              onMouseEnter={(e) => { if (page < totalPages) (e.currentTarget as HTMLButtonElement).style.background = 'var(--m3-surface-container)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '' }}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
