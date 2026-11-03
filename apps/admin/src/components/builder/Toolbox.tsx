import { useMemo, useState } from 'react'

/** Monitor types that report response times, so a chart can be drawn for them. */
export const CHART_TYPES = ['https', 'ping', 'sqlserver', 'postgresql', 'mysql', 'mongodb', 'oracle', 'redis', 'mail', 'ssh', 'tls', 'docker']

interface ToolboxMonitor { id: number; name: string; type: string }

const BLOCKS = [
  { type: 'group', label: 'New group', title: 'Group', icon: 'view_agenda' },
  { type: 'text', label: 'Text', title: 'Text', icon: 'title' },
  { type: 'divider', label: 'Divider', title: 'Divider', icon: 'horizontal_rule' },
  { type: 'incidents', label: 'Incidents', title: 'Incidents', icon: 'warning' },
  { type: 'maintenance', label: 'Maintenance', title: 'Maintenance', icon: 'build' },
]

const Icon = ({ name, size = 16 }: { name: string; size?: number }) => (
  <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: `${size}px` }}>{name}</span>
)

/**
 * The builder's "Add" panel: fixed blocks on top, then a searchable monitor list that can be filtered by type and
 * grouped. Entries are dragged onto the canvas or added at the bottom with their buttons.
 */
export function Toolbox({ monitors, status, usedMonitorIds, chartMonitorIds, onAdd, onDragStart }: {
  monitors: ToolboxMonitor[]
  status: 'pending' | 'error' | 'success'
  /** Monitors that already have a card on the page, and monitors that already have a chart. */
  usedMonitorIds: ReadonlySet<number>
  chartMonitorIds: ReadonlySet<number>
  onAdd: (type: string, monitorId?: number) => void
  onDragStart: (type: string) => void
}) {
  const [query, setQuery] = useState('')
  const [type, setType] = useState('all')
  const [hideAdded, setHideAdded] = useState(false)
  const [grouped, setGrouped] = useState(true)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of monitors) counts.set(m.type, (counts.get(m.type) ?? 0) + 1)
    return [...counts].sort(([a], [b]) => a.localeCompare(b))
  }, [monitors])

  const usedCount = monitors.filter((m) => usedMonitorIds.has(m.id)).length
  const needle = query.trim().toLowerCase()
  const visible = monitors.filter((m) =>
    (type === 'all' || m.type === type)
    && !(hideAdded && usedMonitorIds.has(m.id))
    && (!needle || m.name.toLowerCase().includes(needle) || m.type.toLowerCase().includes(needle)))
  const filtered = needle !== '' || type !== 'all' || hideAdded

  function drag(e: React.DragEvent, nodeType: string, data: Record<string, string> = {}) {
    onDragStart(nodeType)
    e.dataTransfer.setData('nodeType', nodeType)
    for (const [key, value] of Object.entries(data)) e.dataTransfer.setData(key, value)
    e.dataTransfer.effectAllowed = 'copy'
  }

  function toggleGroup(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }

  function row(m: ToolboxMonitor) {
    const used = usedMonitorIds.has(m.id)
    const charted = chartMonitorIds.has(m.id)
    return (
      <div key={m.id} className="group/row flex items-center rounded-md hover:bg-surface-container">
        <div
          draggable
          onDragStart={(e) => drag(e, 'monitor', { monitorId: String(m.id) })}
          className="flex-1 min-w-0 flex items-center gap-1.5 pl-1 py-1 cursor-grab active:cursor-grabbing select-none"
          title={used ? `${m.name} (already on the page)` : m.name}
        >
          <span className="text-secondary opacity-40 group-hover/row:opacity-100 shrink-0" aria-hidden="true"><Icon name="drag_indicator" /></span>
          <span className="text-[9px] uppercase bg-surface-container-high text-secondary px-1 rounded shrink-0">{m.type}</span>
          <span className={`truncate text-sm ${used ? 'text-secondary' : 'text-on-surface-variant'}`}>{m.name}</span>
        </div>
        {CHART_TYPES.includes(m.type) && (
          <button
            type="button"
            onClick={() => onAdd('chart', m.id)}
            aria-label={`Add chart for ${m.name} to the page`}
            title={charted ? 'Chart already on the page, add another' : 'Add chart'}
            className={`btn-icon w-7 h-7 shrink-0 focus-visible:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100 ${charted ? '' : 'opacity-0'}`}
          >
            <Icon name={charted ? 'check' : 'show_chart'} />
          </button>
        )}
        <button
          type="button"
          onClick={() => onAdd('monitor', m.id)}
          aria-label={`Add monitor ${m.name} to the page`}
          title={used ? 'Already on the page, add another' : 'Add to page'}
          className="btn-icon w-7 h-7 mr-0.5 shrink-0"
        >
          <Icon name={used ? 'check' : 'add'} />
        </button>
      </div>
    )
  }

  const groups = typeCounts.map(([t]) => [t, visible.filter((m) => m.type === t)] as const).filter(([, list]) => list.length > 0)
  const showGroups = grouped && type === 'all' && visible.length > 0

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="grid grid-cols-3 gap-1.5 p-3 pb-1">
        {BLOCKS.map((b) => (
          <div
            key={b.type}
            role="button"
            tabIndex={0}
            draggable
            aria-label={`Add ${b.label} to the page`}
            title="Drag onto the canvas or click to add"
            onClick={() => onAdd(b.type)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAdd(b.type) }
            }}
            onDragStart={(e) => drag(e, b.type, b.type === 'group' ? { label: 'New group' } : {})}
            className="flex flex-col items-center gap-0.5 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-[11px] text-on-surface cursor-grab active:cursor-grabbing select-none"
          >
            <span className="text-secondary"><Icon name={b.icon} size={18} /></span>
            {b.title}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
        <p className="text-[10px] uppercase tracking-wider text-secondary">Monitors</p>
        {status === 'success' && (
          <p className="text-[10px] uppercase tracking-wider text-secondary">
            {filtered ? `${visible.length} of ${monitors.length}` : monitors.length}
          </p>
        )}
      </div>

      {monitors.length > 0 && (
        <>
          <div className="relative mx-3">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-secondary pointer-events-none"><Icon name="search" size={15} /></span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search monitor or type"
              aria-label="Search monitors"
              className="w-full rounded-lg bg-surface-container text-sm text-on-surface placeholder:text-secondary pl-7 pr-2 py-1.5 border border-transparent focus:outline-none focus:border-outline-variant"
            />
          </div>
          {typeCounts.length > 1 && (
            <div className="flex gap-1.5 px-3 pt-2 pb-1 overflow-x-auto" role="group" aria-label="Filter by type">
              {[['all', monitors.length] as const, ...typeCounts].map(([t, n]) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={type === t}
                  onClick={() => setType(t)}
                  className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] border ${type === t ? 'bg-surface-container-high text-on-surface border-transparent font-medium' : 'text-secondary border-outline-variant hover:bg-surface-container'}`}
                >
                  {t === 'all' ? 'All' : t}<span className="opacity-70 ml-1 text-[10px]">{n}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between px-3 pt-1 pb-1.5 text-[11px] text-secondary">
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={hideAdded} onChange={(e) => setHideAdded(e.target.checked)} />
              Hide added
            </label>
            <span className="inline-flex rounded-md bg-surface-container p-0.5" role="group" aria-label="List layout">
              {[[true, 'By type'], [false, 'List']].map(([value, label]) => (
                <button
                  key={String(value)}
                  type="button"
                  aria-pressed={grouped === value}
                  onClick={() => setGrouped(value as boolean)}
                  className={`px-2 py-0.5 rounded text-[11px] ${grouped === value ? 'bg-surface-container-high text-on-surface' : ''}`}
                >
                  {label as string}
                </button>
              ))}
            </span>
          </div>
        </>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 border-t border-outline-variant">
        {status === 'pending' && <p className="text-xs text-secondary p-2">Loading monitors…</p>}
        {status === 'error' && <p className="text-xs p-2" style={{ color: 'var(--m3-down)' }}>Couldn't load monitors</p>}
        {status === 'success' && monitors.length === 0 && <p className="text-xs text-secondary p-2">No monitors</p>}
        {status === 'success' && monitors.length > 0 && visible.length === 0 && (
          <div className="p-4 text-center text-xs text-secondary">
            <p>No monitors match.</p>
            <button type="button" className="underline mt-1" onClick={() => { setQuery(''); setType('all'); setHideAdded(false) }}>Clear filters</button>
          </div>
        )}
        {showGroups
          ? groups.map(([t, list]) => {
              const open = needle !== '' || !collapsed.has(t)
              return (
                <div key={t}>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggleGroup(t)}
                    className="sticky top-0 z-[1] flex w-full items-center gap-1 py-1.5 px-1 bg-surface-container-low text-[10px] uppercase tracking-wider text-secondary font-semibold"
                  >
                    <span className={open ? '' : '-rotate-90'}><Icon name="expand_more" size={14} /></span>
                    {t}
                    <span className="ml-auto font-normal normal-case tracking-normal">{list.length}</span>
                  </button>
                  {open && list.map(row)}
                </div>
              )
            })
          : visible.map(row)}
      </div>

      {status === 'success' && monitors.length > 0 && (
        <div className="px-3 py-2 border-t border-outline-variant text-[11px] text-secondary">
          {usedCount} of {monitors.length} monitors on the page
          <div className="h-[3px] rounded bg-surface-container mt-1 overflow-hidden" aria-hidden="true">
            <div className="h-full" style={{ width: `${(usedCount / monitors.length) * 100}%`, background: 'var(--m3-up)' }} />
          </div>
        </div>
      )}
    </div>
  )
}
