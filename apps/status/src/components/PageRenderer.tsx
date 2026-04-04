import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type {
  LayoutTree, LayoutNode, GroupNode, MonitorNode, TextNode,
  IncidentsNode, Monitor, MonitorStatus, Incident,
} from '@bsp/shared'
import Markdown from 'react-markdown'
import { IncidentCard } from './IncidentCard'

interface StatusInfo {
  status: MonitorStatus
  responseMs: number | null
  checkedAt: number
}

interface Props {
  tree: LayoutTree
  monitors: Monitor[]
  statusMap: Record<number, StatusInfo>
  activeIncidents?: Incident[]
  allIncidents?: Incident[]
}

export function PageRenderer({
  tree, monitors, statusMap,
  activeIncidents = [], allIncidents = [],
}: Props) {
  const sorted = [...tree.children].sort((a, b) => {
    const ay = a.grid?.y ?? 0, ax = a.grid?.x ?? 0
    const by = b.grid?.y ?? 0, bx = b.grid?.x ?? 0
    return ay !== by ? ay - by : ax - bx
  })

  return (
    <section
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '24px',
      }}
    >
      {sorted.map((node) => (
        <div
          key={node.id}
          style={{
            gridColumn: `${(node.grid?.x ?? 0) + 1} / span ${node.grid?.w ?? 3}`,
            minWidth: 0,
          }}
        >
          <NodeRenderer
            node={node}
            monitors={monitors}
            statusMap={statusMap}
            activeIncidents={activeIncidents}
            allIncidents={allIncidents}
          />
        </div>
      ))}
    </section>
  )
}

function NodeRenderer({
  node, monitors, statusMap, activeIncidents, allIncidents,
}: {
  node: LayoutNode
  monitors: Monitor[]
  statusMap: Record<number, StatusInfo>
  activeIncidents: Incident[]
  allIncidents: Incident[]
}) {
  if (node.type === 'divider') {
    return (
      <div className="bsp-divider my-8 flex items-center gap-3">
        <span className="flex-1 h-px" style={{ background: 'var(--m3-outline-variant)' }} />
      </div>
    )
  }

  if (node.type === 'text') {
    const n = node as TextNode
    return (
      <div
        className="bsp-text-block py-4 px-2"
        style={{ color: 'var(--m3-on-surface-variant)' }}
      >
        <Markdown
          components={{
            h1: ({ children }) => (
              <h1 className="font-headline font-extrabold text-4xl tracking-tight mb-3" style={{ color: 'var(--m3-on-surface)' }}>{children}</h1>
            ),
            h2: ({ children }) => (
              <h2 className="font-headline font-bold text-2xl tracking-tight mb-2" style={{ color: 'var(--m3-on-surface)' }}>{children}</h2>
            ),
            h3: ({ children }) => (
              <h3 className="font-headline font-semibold text-xl mb-2" style={{ color: 'var(--m3-on-surface)' }}>{children}</h3>
            ),
            p: ({ children }) => (
              <p className="font-sans text-base leading-relaxed mb-3" style={{ color: 'var(--m3-secondary)' }}>{children}</p>
            ),
          }}
        >
          {n.markdown}
        </Markdown>
      </div>
    )
  }

  if (node.type === 'monitor') {
    const monNode = node as MonitorNode
    const monitor = monitors.find((m) => m.id === monNode.monitorId)
    if (!monitor) return null
    const live = statusMap[monitor.id]
    const liveMonitor = { ...monitor, currentStatus: live?.status ?? monitor.currentStatus }

    if ((monNode.cardVariant ?? 'default') === 'compact') {
      return (
        <CompactMonitorRow
          monitor={liveMonitor}
          responseMs={live?.responseMs ?? null}
          showResponseTime={monNode.showResponseTime}
          showMonitorType={monNode.showMonitorType ?? false}
        />
      )
    }

    return (
      <ServiceMonitorCard
        monitor={liveMonitor}
        responseMs={live?.responseMs ?? null}
        monitorId={monitor.id}
        showUptimeBar={monNode.showUptimeBar}
        showResponseTime={monNode.showResponseTime}
        showMonitorType={monNode.showMonitorType ?? false}
        uptimeBarPosition={monNode.uptimeBarPosition ?? 'right'}
        showUptimePct={monNode.showUptimePct ?? false}
        gridW={monNode.grid?.w ?? 3}
      />
    )
  }

  if (node.type === 'group') {
    return (
      <GroupBlock
        groupNode={node as GroupNode}
        monitors={monitors}
        statusMap={statusMap}
      />
    )
  }

  if (node.type === 'incidents') {
    return (
      <IncidentsBlock
        config={node as IncidentsNode}
        activeIncidents={activeIncidents}
        allIncidents={allIncidents}
        monitors={monitors}
      />
    )
  }

  return null
}

/* ─────────────────────────────────────────────────────────────────────
   SERVICE MONITOR CARD  (large variant — matches design exactly)
   ───────────────────────────────────────────────────────────────────── */
function ServiceMonitorCard({
  monitor, responseMs, monitorId,
  showUptimeBar, showResponseTime,
  uptimeBarPosition = 'right',
  showUptimePct = false,
  gridW = 3,
}: {
  monitor: Monitor
  responseMs: number | null
  monitorId: number
  showUptimeBar: boolean
  showResponseTime: boolean
  showMonitorType?: boolean
  uptimeBarPosition?: 'right' | 'below'
  showUptimePct?: boolean
  gridW?: number
}) {
  const [overallPct, setOverallPct] = useState<number | null>(null)

  const isUp       = monitor.currentStatus === 'up'
  const isDown     = monitor.currentStatus === 'down'
  const isDegraded = monitor.currentStatus === 'degraded'

  const statusLabel   = isUp ? 'Operational' : isDown ? 'Outage' : isDegraded ? 'Degraded' : 'Checking'
  const statusBg      = isUp ? 'rgba(34,197,94,0.12)' : isDown ? '#ffdad6' : isDegraded ? 'rgba(234,179,8,0.12)' : 'var(--m3-surface-container)'
  const statusColor   = isUp ? '#166534' : isDown ? '#ba1a1a' : isDegraded ? '#854d0e' : 'var(--m3-secondary)'
  const dotColor      = isUp ? '#22c55e'  : isDown ? '#ba1a1a' : isDegraded ? '#eab308' : 'var(--m3-secondary)'
  const barColor      = isDown ? '#ba1a1a' : isDegraded ? '#eab308' : 'var(--bsp-up)'
  const barColorLight = isDown ? '#f28b82' : isDegraded ? '#fcd34d' : '#4ade80'

  const uptimeLabel = (overallPct !== null && showUptimePct)
    ? `${overallPct.toFixed(1)}% uptime`
    : null

  // Right-position layout: gridW=1 → dot only; gridW=2 → compact pill; gridW≥3 → full pill
  const StatusBadgeRight = () => {
    if (gridW === 1) {
      return (
        <div style={{ flexShrink: 0, position: 'relative', width: 14, height: 14 }}>
          {(isDown || isDegraded) && (
            <span className="monitor-dot-ring" style={{ background: dotColor, opacity: 0.4 }} />
          )}
          <span style={{ display: 'block', width: '100%', height: '100%', borderRadius: '50%', background: dotColor }} />
        </div>
      )
    }
    return (
      <span
        style={{
          background: statusBg, color: statusColor,
          padding: '6px 14px', borderRadius: '999px',
          fontSize: '13px', fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
          flexShrink: 0,
          minWidth: gridW === 2 ? '96px' : '114px',
        }}
      >
        {(isDown || isDegraded) && (
          <span
            className="animate-pulse"
            style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor, display: 'inline-block', flexShrink: 0 }}
          />
        )}
        {statusLabel}
      </span>
    )
  }

  // Below-position / no-bars layout: always full pill
  const StatusBadgeBelow = () => (
    <span
      style={{
        background: statusBg, color: statusColor,
        padding: '6px 14px', borderRadius: '999px',
        fontSize: '13px', fontWeight: 700,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
        flexShrink: 0,
        minWidth: '114px',
      }}
    >
      {(isDown || isDegraded) && (
        <span
          className="animate-pulse"
          style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor, display: 'inline-block', flexShrink: 0 }}
        />
      )}
      {statusLabel}
    </span>
  )

  const NameBlock = () => (
    <div style={{ width: '160px', flexShrink: 0 }}>
      <h3
        className="font-headline font-bold"
        style={{ fontSize: '28px', lineHeight: 1.15, color: 'var(--bsp-text)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingBottom: '3px' }}
      >
        {monitor.name}
      </h3>
      <p
        className="font-mono uppercase"
        style={{ fontSize: '11px', letterSpacing: '0.09em', color: 'var(--m3-secondary)', marginTop: '4px' }}
      >
        {monitor.type.toUpperCase()}
        {showResponseTime && responseMs !== null && ` · ${responseMs}ms`}
      </p>
    </div>
  )

  /* ── Right: bars fill the gap between name and badge ── */
  if (showUptimeBar && uptimeBarPosition === 'right') {
    return (
      <div className="bsp-monitor-card" style={{ padding: '28px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <NameBlock />
          <UptimeBarsInline monitorId={monitorId} barColor={barColor} barColorLight={barColorLight} />
          <StatusBadgeRight />
        </div>
      </div>
    )
  }

  /* ── Below: stacked layout ── */
  return (
    <div className="bsp-monitor-card" style={{ padding: '28px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: showUptimeBar ? '20px' : '0', gap: '16px' }}>
        <NameBlock />
        <StatusBadgeBelow />
      </div>

      {showUptimeBar && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '10px', fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--m3-secondary)' }}>
              30 days ago
            </span>
            {uptimeLabel && (
              <span style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--m3-on-surface)' }}>
                {uptimeLabel}
              </span>
            )}
            <span style={{ fontSize: '10px', fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--m3-secondary)' }}>
              Today
            </span>
          </div>
          <UptimeBars
            monitorId={monitorId}
            barColor={barColor}
            barColorLight={barColorLight}
            isDown={isDown}
            isDegraded={isDegraded}
            onData={(pct) => setOverallPct(pct)}
          />
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────
   COMPACT MONITOR ROW  (slim — for compact variant and group children)
   ───────────────────────────────────────────────────────────────────── */
function CompactMonitorRow({
  monitor, responseMs, showResponseTime, showMonitorType = false, nested = false,
}: {
  monitor: Monitor
  responseMs: number | null
  showResponseTime: boolean
  showMonitorType?: boolean
  nested?: boolean
}) {
  const isUp       = monitor.currentStatus === 'up'
  const isDown     = monitor.currentStatus === 'down'
  const isDegraded = monitor.currentStatus === 'degraded'

  const statusLabel = isUp ? 'Operational' : isDown ? 'Down' : isDegraded ? 'Degraded' : 'Checking'
  const statusBg    = isUp
    ? 'rgba(34,197,94,0.1)'
    : isDown ? '#ffdad6'
    : isDegraded ? 'rgba(234,179,8,0.12)'
    : 'var(--m3-surface-container)'
  const statusColor = isUp ? '#166534' : isDown ? '#ba1a1a' : isDegraded ? '#854d0e' : 'var(--m3-secondary)'
  const dotColor    = isUp ? '#22c55e'  : isDown ? '#ba1a1a' : isDegraded ? '#eab308' : 'var(--m3-outline)'

  return (
    <div
      className={nested ? '' : 'bsp-monitor-card card-hover'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: nested ? '10px 20px 10px 24px' : '12px 16px',
        borderRadius: nested ? 0 : '12px',
        overflow: 'hidden',
      }}
    >
      {/* Status dot */}
      <div className="relative flex-shrink-0" style={{ width: 8, height: 8 }}>
        {(isDown || isDegraded) && (
          <span
            className="monitor-dot-ring"
            style={{ background: dotColor, opacity: 0.4 }}
          />
        )}
        <span
          className="block w-full h-full rounded-full"
          style={{ background: dotColor }}
        />
      </div>

      {/* Name */}
      <span
        className="bsp-monitor-name font-sans font-medium text-sm flex-1 truncate"
        style={{ color: 'var(--bsp-text)' }}
      >
        {monitor.name}
      </span>

      {/* Type */}
      {showMonitorType && (
        <span
          className="font-mono text-[10px] uppercase flex-shrink-0 px-1.5 py-0.5 rounded"
          style={{ color: 'var(--m3-secondary)', background: 'var(--m3-surface-container)' }}
        >
          {monitor.type}
        </span>
      )}

      {/* Response time */}
      {showResponseTime && responseMs !== null && (
        <span className="font-mono text-xs flex-shrink-0" style={{ color: 'var(--m3-secondary)' }}>
          {responseMs}ms
        </span>
      )}

      {/* Status badge */}
      <span
        className="text-xs font-sans font-semibold px-2.5 py-1 rounded-full flex-shrink-0"
        style={{ background: statusBg, color: statusColor }}
      >
        {statusLabel}
      </span>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────
   GROUP BLOCK  (header with aggregate + compact child rows)
   ───────────────────────────────────────────────────────────────────── */
function GroupBlock({ groupNode, monitors, statusMap }: {
  groupNode: GroupNode
  monitors: Monitor[]
  statusMap: Record<number, StatusInfo>
}) {
  const [collapsed, setCollapsed] = useState(false)

  const liveMonitors = groupNode.children
    .filter((c) => c.type === 'monitor')
    .map((c) => {
      const monNode = c as MonitorNode
      const m = monitors.find((mon) => mon.id === monNode.monitorId)
      if (!m) return null
      return { ...m, currentStatus: statusMap[m.id]?.status ?? m.currentStatus }
    })
    .filter(Boolean) as Monitor[]

  const anyDown     = liveMonitors.some((m) => m.currentStatus === 'down')
  const anyDegraded = liveMonitors.some((m) => m.currentStatus === 'degraded')
  const aggStatus   = anyDown ? 'down' : anyDegraded ? 'degraded' : 'up'

  const aggColor    = aggStatus === 'down' ? '#ba1a1a' : aggStatus === 'degraded' ? '#854d0e' : '#166534'
  const aggDotColor = aggStatus === 'down' ? '#ba1a1a' : aggStatus === 'degraded' ? '#eab308' : '#22c55e'
  const aggBg       = aggStatus === 'up' ? 'rgba(34,197,94,0.1)' : aggStatus === 'down' ? '#ffdad6' : 'rgba(234,179,8,0.12)'
  const aggLabel    = aggStatus === 'up' ? 'Operational' : aggStatus === 'down' ? 'Outage' : 'Degraded'

  return (
    <div
      className="bsp-group-card overflow-hidden"
      style={{ borderRadius: '1rem' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-5 py-4"
        style={{
          cursor: groupNode.collapsible ? 'pointer' : 'default',
          userSelect: 'none',
          transition: 'background 0.15s',
        }}
        onClick={() => groupNode.collapsible && setCollapsed(!collapsed)}
        onMouseEnter={(e) => {
          if (groupNode.collapsible)
            (e.currentTarget as HTMLDivElement).style.background = 'var(--m3-surface-container)'
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLDivElement).style.background = ''
        }}
      >
        <div className="flex items-center gap-3">
          <div className="relative flex-shrink-0" style={{ width: 10, height: 10 }}>
            {aggStatus !== 'up' && (
              <span
                className="monitor-dot-ring"
                style={{ background: aggDotColor, opacity: 0.4 }}
              />
            )}
            <span
              className="block w-full h-full rounded-full"
              style={{ background: aggDotColor }}
            />
          </div>
          <span
            className="bsp-group-label font-headline font-semibold"
            style={{ color: 'var(--bsp-text)', fontSize: '0.95rem' }}
          >
            {groupNode.label}
          </span>
          <span
            className="text-xs"
            style={{ color: 'var(--m3-secondary)' }}
          >
            {liveMonitors.length} service{liveMonitors.length !== 1 ? 's' : ''}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span
            className="text-xs font-sans font-semibold px-2.5 py-1 rounded-full"
            style={{ background: aggBg, color: aggColor }}
          >
            {aggLabel}
          </span>
          {groupNode.collapsible && (
            <span
              className="material-symbols-outlined"
              style={{
                fontSize: '18px',
                color: 'var(--m3-secondary)',
                transform: collapsed ? 'rotate(-90deg)' : 'none',
                transition: 'transform 0.2s ease',
              }}
            >
              expand_more
            </span>
          )}
        </div>
      </div>

      {/* Children */}
      {!collapsed && groupNode.children.length > 0 && (
        <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
          {groupNode.children.map((child, i) => {
            const borderStyle = i > 0 ? { borderTop: '1px solid var(--m3-outline-variant)' } : {}

            if (child.type === 'monitor') {
              const monNode = child as MonitorNode
              const m = monitors.find((mon) => mon.id === monNode.monitorId)
              if (!m) return null
              const live = statusMap[m.id]
              const liveMonitor = { ...m, currentStatus: live?.status ?? m.currentStatus }
              const isFullCard = (monNode.cardVariant ?? 'compact') === 'default'

              return (
                <div key={child.id} style={borderStyle}>
                  {isFullCard ? (
                    <div style={{ padding: '12px 16px' }}>
                      <ServiceMonitorCard
                        monitor={liveMonitor}
                        responseMs={live?.responseMs ?? null}
                        monitorId={m.id}
                        showUptimeBar={monNode.showUptimeBar}
                        showResponseTime={monNode.showResponseTime}
                        showMonitorType={monNode.showMonitorType ?? false}
                        uptimeBarPosition={monNode.uptimeBarPosition ?? 'right'}
                        showUptimePct={monNode.showUptimePct ?? false}
                        gridW={groupNode.grid?.w ?? 3}
                      />
                    </div>
                  ) : (
                    <CompactMonitorRow
                      monitor={liveMonitor}
                      responseMs={live?.responseMs ?? null}
                      showResponseTime={monNode.showResponseTime}
                      showMonitorType={monNode.showMonitorType ?? false}
                      nested
                    />
                  )}
                </div>
              )
            }

            if (child.type === 'text') {
              return (
                <div
                  key={child.id}
                  className="px-5 py-3 text-sm"
                  style={{ ...borderStyle, color: 'var(--m3-secondary)' }}
                >
                  <Markdown>{(child as TextNode).markdown}</Markdown>
                </div>
              )
            }

            return null
          })}
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────
   INCIDENTS BLOCK  (configurable incident list)
   ───────────────────────────────────────────────────────────────────── */
function IncidentsBlock({ config, activeIncidents, allIncidents, monitors }: {
  config: IncidentsNode
  activeIncidents: Incident[]
  allIncidents: Incident[]
  monitors: Monitor[]
}) {
  const filter = config.filter ?? 'all'
  const limit  = config.limit ?? 5

  const items = filter === 'active'
    ? activeIncidents
    : filter === 'resolved'
    ? allIncidents.filter((i) => i.status === 'resolved')
    : [...activeIncidents, ...allIncidents.filter((i) => i.status === 'resolved')]

  const shown = items.slice(0, limit)

  if (shown.length === 0) {
    // When filtering only active incidents, hide the block entirely — no empty state
    if (filter === 'active') return null

    return (
      <div
        className="rounded-2xl p-10 text-center"
        style={{
          background: 'var(--m3-surface-container-lowest)',
          boxShadow: '0px 12px 32px rgba(19,27,46,0.04)',
        }}
      >
        <span
          className="material-symbols-outlined block mb-3"
          style={{ fontSize: '32px', color: '#22c55e' }}
        >
          check_circle
        </span>
        <p className="font-sans text-sm font-medium" style={{ color: 'var(--m3-secondary)' }}>
          No incidents to display.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {shown.map((incident) => (
        <IncidentCard key={incident.id} incident={incident} monitors={monitors} />
      ))}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────
   UPTIME SHARED TYPES + TOOLTIP
   ───────────────────────────────────────────────────────────────────── */
interface UptimeDay {
  date: string
  status: string
  uptimePct: number
  incidents?: Array<{ id: number; title: string; durationMs: number | null }>
}

function fmtDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function UptimeTooltip({ day, anchorRect }: { day: UptimeDay; anchorRect: DOMRect }) {
  const W = 232
  const vw = window.innerWidth
  let left = anchorRect.left + anchorRect.width / 2 - W / 2
  left = Math.max(8, Math.min(left, vw - W - 8))
  const bottom = window.innerHeight - anchorRect.top + 10

  const dateLabel = new Date(day.date + 'T12:00:00Z').toLocaleDateString('en', {
    month: 'long', day: 'numeric', year: 'numeric',
  })
  const hasIncidents = day.incidents && day.incidents.length > 0
  const noData = day.status === 'no-data'

  return createPortal(
    <div style={{
      position: 'fixed',
      bottom, left,
      width: W,
      zIndex: 9999,
      background: 'var(--m3-surface-container-high)',
      border: '1px solid var(--m3-outline-variant)',
      borderRadius: '12px',
      padding: '12px 14px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      pointerEvents: 'none',
    }}>
      {/* Date */}
      <p style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 700, fontSize: '12px', color: 'var(--m3-on-surface)', margin: '0 0 4px' }}>
        {dateLabel}
      </p>

      {/* Uptime */}
      {!noData && (
        <p style={{ fontSize: '11px', color: 'var(--m3-secondary)', margin: '0 0 6px' }}>
          Uptime: {day.uptimePct.toFixed(1)}%
        </p>
      )}
      {noData && (
        <p style={{ fontSize: '11px', color: 'var(--m3-secondary)', margin: '0 0 6px' }}>
          No data
        </p>
      )}

      {/* Incidents */}
      {hasIncidents ? (
        <div style={{ borderTop: '1px solid var(--m3-outline-variant)', paddingTop: '6px' }}>
          {day.incidents!.map((inc) => (
            <div key={inc.id} style={{ marginBottom: '4px' }}>
              <p style={{ fontSize: '11px', fontWeight: 600, color: 'var(--m3-on-surface)', margin: 0 }}>
                {inc.title}
              </p>
              <p style={{ fontSize: '10px', color: 'var(--m3-secondary)', margin: '1px 0 0' }}>
                {inc.durationMs !== null ? `Resolved in ${fmtDuration(inc.durationMs)}` : 'Ongoing'}
              </p>
            </div>
          ))}
        </div>
      ) : !noData && (
        <p style={{ fontSize: '10px', color: 'var(--m3-secondary)', margin: 0, borderTop: '1px solid var(--m3-outline-variant)', paddingTop: '6px' }}>
          No incidents
        </p>
      )}
    </div>,
    document.body,
  )
}

/* ─────────────────────────────────────────────────────────────────────
   UPTIME BARS — full 40-bar version (below position)
   ───────────────────────────────────────────────────────────────────── */
function UptimeBars({ monitorId, barColor, barColorLight, isDown, isDegraded, onData }: {
  monitorId: number
  barColor: string
  barColorLight: string
  isDown: boolean
  isDegraded: boolean
  onData?: ((pct: number) => void) | undefined
}) {
  const [data, setData] = useState<UptimeDay[] | null>(null)
  const [hovered, setHovered] = useState<{ day: UptimeDay; rect: DOMRect } | null>(null)

  useEffect(() => {
    fetch(`/api/v1/public/monitor/${monitorId}/uptime?days=30`)
      .then((r) => r.json())
      .then((res: { days: UptimeDay[]; overallUptimePct: number }) => {
        setData(res.days)
        onData?.(res.overallUptimePct)
      })
      .catch(() => {})
  }, [monitorId])

  const barColorOf = (day: UptimeDay) =>
    day.status === 'up' ? `linear-gradient(to top, ${barColor}, ${barColorLight})`
    : day.status === 'down' ? '#ba1a1a'
    : day.status === 'degraded' ? '#eab308'
    : 'var(--m3-outline-variant)'

  const bars: UptimeDay[] = data
    ? data.slice(-40)
    : Array.from({ length: 40 }).map((_, i) => {
        const isLast3 = i >= 37
        return { date: String(i), status: isLast3 && (isDown || isDegraded) ? (isDown ? 'down' : 'degraded') : 'up', uptimePct: 100 }
      })

  return (
    <>
      {hovered && <UptimeTooltip day={hovered.day} anchorRect={hovered.rect} />}
      <div className="flex h-10 items-end" style={{ gap: '2px' }}>
        {bars.map((day, i) => (
          <div
            key={day.date ?? i}
            className="flex-1 rounded-sm"
            style={{
              height: '100%',
              background: barColorOf(day),
              opacity: day.status === 'no-data' ? 0.3 : !data ? 0.7 : 1,
              cursor: 'default',
              transition: 'filter 0.12s ease, transform 0.12s ease',
              transformOrigin: 'bottom',
              filter: hovered?.day.date === day.date ? 'brightness(1.5)' : 'brightness(1)',
              transform: hovered?.day.date === day.date ? 'scaleY(1.08)' : 'scaleY(1)',
            }}
            onMouseEnter={(e) => data && setHovered({ day, rect: (e.currentTarget as HTMLDivElement).getBoundingClientRect() })}
            onMouseLeave={() => setHovered(null)}
          />
        ))}
      </div>
    </>
  )
}

/* ─────────────────────────────────────────────────────────────────────
   UPTIME BARS INLINE — always spans name→badge; count reduces if narrow
   Each bar uses flex:1 so they fill the space evenly. ResizeObserver
   reduces count when container < 30 bars × min 3px + gaps.
   ───────────────────────────────────────────────────────────────────── */
function UptimeBarsInline({ monitorId, barColor, barColorLight }: {
  monitorId: number
  barColor: string
  barColorLight: string
}) {
  const [data, setData] = useState<UptimeDay[] | null>(null)
  const [barCount, setBarCount] = useState(30)
  const [hovered, setHovered] = useState<{ day: UptimeDay; rect: DOMRect } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch(`/api/v1/public/monitor/${monitorId}/uptime?days=30`)
      .then((r) => r.json())
      .then((res: { days: UptimeDay[] }) => { setData(res.days) })
      .catch(() => {})
  }, [monitorId])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return
      // min bar width 3px + 2px gap = 5px per slot; +2 to account for no trailing gap
      setBarCount(Math.min(30, Math.max(1, Math.floor((entry.contentRect.width + 2) / 5))))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const barColorOf = (day: UptimeDay) =>
    day.status === 'up' ? `linear-gradient(to top, ${barColor}, ${barColorLight})`
    : day.status === 'down' ? '#ba1a1a'
    : day.status === 'degraded' ? '#eab308'
    : 'var(--m3-outline-variant)'

  const bars: UptimeDay[] = data
    ? data.slice(-barCount)
    : Array.from({ length: barCount }).map((_, i) => ({ date: String(i), status: 'up', uptimePct: 100 }))

  return (
    <>
      {hovered && <UptimeTooltip day={hovered.day} anchorRect={hovered.rect} />}
      <div
        ref={containerRef}
        style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'stretch', gap: '2px', height: '48px' }}
      >
        {bars.map((day, i) => (
          <div
            key={day.date ?? i}
            style={{
              flex: 1,
              borderRadius: '3px',
              background: barColorOf(day),
              opacity: day.status === 'no-data' ? 0.35 : data ? 1 : 0.5,
              cursor: 'default',
              transition: 'filter 0.12s ease, transform 0.12s ease',
              transformOrigin: 'bottom',
              filter: hovered?.day.date === day.date ? 'brightness(1.5)' : 'brightness(1)',
              transform: hovered?.day.date === day.date ? 'scaleY(1.08)' : 'scaleY(1)',
            }}
            onMouseEnter={(e) => data && setHovered({ day, rect: (e.currentTarget as HTMLDivElement).getBoundingClientRect() })}
            onMouseLeave={() => setHovered(null)}
          />
        ))}
      </div>
    </>
  )
}
