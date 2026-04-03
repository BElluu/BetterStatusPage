import { useState, useEffect, useRef } from 'react'
import type { LayoutTree, LayoutNode, GroupNode, MonitorNode, TextNode, Monitor, MonitorStatus } from '@bsp/shared'
import Markdown from 'react-markdown'

interface StatusInfo {
  status: MonitorStatus
  responseMs: number | null
  checkedAt: number
}

interface Props {
  tree: LayoutTree
  monitors: Monitor[]
  statusMap: Record<number, StatusInfo>
}

export function PageRenderer({ tree, monitors, statusMap }: Props) {
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
        gap: '10px',
      }}
    >
      {sorted.map((node) => (
        <div
          key={node.id}
          style={{
            gridColumn: `${(node.grid?.x ?? 0) + 1} / span ${node.grid?.w ?? 3}`,
          }}
        >
          <NodeRenderer node={node} monitors={monitors} statusMap={statusMap} />
        </div>
      ))}
    </section>
  )
}

function NodeRenderer({ node, monitors, statusMap }: { node: LayoutNode; monitors: Monitor[]; statusMap: Record<number, StatusInfo> }) {
  if (node.type === 'divider') {
    return <hr className="bsp-divider my-4" style={{ border: 'none', borderTop: '1px solid var(--bsp-card-border)' }} />
  }

  if (node.type === 'text') {
    const textNode = node as TextNode
    return (
      <div className="bsp-text-block prose prose-invert prose-sm max-w-none py-2" style={{ color: 'var(--bsp-text-muted)' }}>
        <Markdown>{textNode.markdown}</Markdown>
      </div>
    )
  }

  if (node.type === 'monitor') {
    const monNode = node as MonitorNode
    const monitor = monitors.find((m) => m.id === monNode.monitorId)
    if (!monitor) return null
    const live = statusMap[monitor.id]
    return (
      <MonitorRow
        monitor={{ ...monitor, currentStatus: live?.status ?? monitor.currentStatus }}
        responseMs={live?.responseMs ?? null}
        showUptimeBar={monNode.showUptimeBar}
        showResponseTime={monNode.showResponseTime}
        uptimeBarPosition={monNode.uptimeBarPosition ?? 'right'}
        showMonitorType={monNode.showMonitorType ?? false}
        showUptimePct={monNode.showUptimePct ?? false}
        monitorId={monitor.id}
      />
    )
  }

  if (node.type === 'group') {
    return <GroupBlock groupNode={node as GroupNode} monitors={monitors} statusMap={statusMap} />
  }

  return null
}

function GroupBlock({ groupNode, monitors, statusMap }: { groupNode: GroupNode; monitors: Monitor[]; statusMap: Record<number, StatusInfo> }) {
  const [collapsed, setCollapsed] = useState(false)

  const groupMonitors = groupNode.children
    .filter((c) => c.type === 'monitor')
    .map((c) => {
      const monNode = c as MonitorNode
      const monitor = monitors.find((m) => m.id === monNode.monitorId)
      if (!monitor) return null
      return { ...monitor, currentStatus: statusMap[monitor.id]?.status ?? monitor.currentStatus }
    })
    .filter(Boolean) as Monitor[]

  const anyDown = groupMonitors.some((m) => m.currentStatus === 'down')
  const anyDegraded = groupMonitors.some((m) => m.currentStatus === 'degraded')
  const aggStatus = anyDown ? 'down' : anyDegraded ? 'degraded' : 'up'
  const aggColor = aggStatus === 'down' ? 'var(--bsp-down)' : aggStatus === 'degraded' ? 'var(--bsp-degraded)' : 'var(--bsp-up)'
  const aggLabel = aggStatus === 'up' ? 'Operational' : aggStatus === 'down' ? 'Outage' : 'Degraded'

  return (
    <div className="bsp-group-card rounded-xl overflow-hidden">
      <div
        className={`bsp-group-header flex items-center justify-between px-4 py-3 shrink-0 ${groupNode.collapsible ? 'cursor-pointer' : ''}`}
        style={groupNode.collapsible ? { transition: 'background 0.15s' } : {}}
        onClick={() => groupNode.collapsible && setCollapsed(!collapsed)}
        onMouseEnter={(e) => groupNode.collapsible && ((e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.04)')}
        onMouseLeave={(e) => groupNode.collapsible && ((e.currentTarget as HTMLDivElement).style.background = '')}
      >
        <div className="flex items-center gap-3">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: aggColor }} />
          <span className="bsp-group-label font-medium" style={{ color: 'var(--bsp-text)' }}>{groupNode.label}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: aggColor }}>{aggLabel}</span>
          {groupNode.collapsible && (
            <span className="text-sm" style={{ color: 'var(--bsp-text-muted)' }}>{collapsed ? '▸' : '▾'}</span>
          )}
        </div>
      </div>

      {!collapsed && groupNode.children.length > 0 && (
        <div style={{ borderTop: '1px solid var(--bsp-card-border)' }}>
          {groupNode.children.map((child, i) => {
            if (child.type === 'monitor') {
              const monNode = child as MonitorNode
              const monitor = monitors.find((m) => m.id === monNode.monitorId)
              if (!monitor) return null
              const live = statusMap[monitor.id]
              return (
                <div key={child.id} style={i > 0 ? { borderTop: '1px solid var(--bsp-card-border)' } : {}}>
                  <MonitorRow
                    monitor={{ ...monitor, currentStatus: live?.status ?? monitor.currentStatus }}
                    responseMs={live?.responseMs ?? null}
                    showUptimeBar={monNode.showUptimeBar}
                    showResponseTime={monNode.showResponseTime}
                    uptimeBarPosition={monNode.uptimeBarPosition ?? 'right'}
                    showMonitorType={monNode.showMonitorType ?? false}
                    showUptimePct={monNode.showUptimePct ?? false}
                    monitorId={monitor.id}
                    nested
                  />
                </div>
              )
            }
            return (
              <div key={child.id} className="px-4" style={i > 0 ? { borderTop: '1px solid var(--bsp-card-border)' } : {}}>
                <NodeRenderer node={child} monitors={monitors} statusMap={statusMap} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function MonitorRow({
  monitor,
  responseMs,
  showUptimeBar,
  showResponseTime,
  uptimeBarPosition = 'right',
  showMonitorType = false,
  showUptimePct = false,
  monitorId,
  nested = false,
}: {
  monitor: Monitor
  responseMs: number | null
  showUptimeBar: boolean
  showResponseTime: boolean
  uptimeBarPosition?: 'right' | 'below'
  showMonitorType?: boolean
  showUptimePct?: boolean
  monitorId: number
  nested?: boolean
}) {
  const [overallPct, setOverallPct] = useState<number | null>(null)

  const statusColor = {
    up: 'var(--bsp-up)',
    down: 'var(--bsp-down)',
    degraded: 'var(--bsp-degraded)',
    pending: 'var(--bsp-text-muted)',
  }
  const statusLabel = { up: 'Operational', down: 'Down', degraded: 'Degraded', pending: 'Checking' }
  const color = statusColor[monitor.currentStatus as keyof typeof statusColor] ?? statusColor.pending
  const label = statusLabel[monitor.currentStatus as keyof typeof statusLabel] ?? 'Checking'

  const outerStyle: React.CSSProperties = nested
    ? { padding: '10px 16px 10px 24px' }
    : { borderRadius: '8px', padding: '10px 14px' }

  return (
    <div className="bsp-monitor-card flex flex-col overflow-hidden" style={outerStyle}>
      {/* Main row: name — [type] — [bars if right] — status */}
      <div className="flex items-center gap-2">
        {/* Name: always fully visible */}
        <span className="bsp-monitor-name text-sm flex-shrink-0" style={{ color: 'var(--bsp-text)' }}>
          {monitor.name}
        </span>
        {/* Monitor type badge */}
        {showMonitorType && (
          <span className="text-[10px] uppercase flex-shrink-0 px-1 rounded" style={{ color: 'var(--bsp-text-muted)', background: 'rgba(255,255,255,0.06)' }}>
            {monitor.type}
          </span>
        )}
        {/* Response time */}
        {showResponseTime && responseMs !== null && (
          <span className="text-xs flex-shrink-0" style={{ color: 'var(--bsp-text-muted)' }}>{responseMs}ms</span>
        )}
        {/* Uptime bars inline (right position): fill space between name and status */}
        {showUptimeBar && uptimeBarPosition === 'right' && (
          <div className="bsp-uptime-bar flex-1 overflow-hidden min-w-0">
            <UptimeBar monitorId={monitorId} />
          </div>
        )}
        {/* Spacer when no inline bars */}
        {(!showUptimeBar || uptimeBarPosition === 'below') && <div className="flex-1" />}
        {/* Status: dot + label */}
        <div className="bsp-monitor-status flex items-center gap-1.5 flex-shrink-0">
          <span className="w-2 h-2 rounded-full" style={{ background: color }} />
          <span className="text-xs" style={{ color }}>{label}</span>
        </div>
      </div>
      {/* Uptime bars below */}
      {showUptimeBar && uptimeBarPosition === 'below' && (
        <div className="bsp-uptime-bar mt-2 flex items-center gap-2">
          {/* Bracketed bars */}
          <div className="flex-1 min-w-0 overflow-hidden" style={{
            borderLeft: '2px solid var(--bsp-card-border)',
            borderRight: '2px solid var(--bsp-card-border)',
            paddingLeft: '4px',
            paddingRight: '4px',
          }}>
            <UptimeBar monitorId={monitorId} onData={showUptimePct ? setOverallPct : undefined} />
          </div>
          {/* Overall uptime % */}
          {showUptimePct && overallPct !== null && (
            <span className="text-xs flex-shrink-0" style={{ color: 'var(--bsp-text-muted)' }}>
              {overallPct.toFixed(2)}% uptime
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function UptimeBar({ monitorId, onData }: { monitorId: number; onData?: (pct: number) => void }) {
  const [data, setData] = useState<Array<{ date: string; status: string; uptimePct: number }> | null>(null)
  const [visibleCount, setVisibleCount] = useState(30)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch(`/api/v1/public/monitor/${monitorId}/uptime?days=30`)
      .then((r) => r.json())
      .then((res: { days: Array<{ date: string; status: string; uptimePct: number }>; overallUptimePct: number }) => {
        setData(res.days)
        onData?.(res.overallUptimePct)
      })
      .catch(() => {})
  }, [monitorId])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      // each bar: 6px (w-1.5) + 2px gap (gap-0.5) = 8px, except last bar has no trailing gap
      const count = Math.floor((entry.contentRect.width + 2) / 8)
      setVisibleCount(Math.min(30, Math.max(0, count)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  if (!data) return null

  return (
    <div ref={containerRef} className="flex gap-0.5 items-center justify-end" title="30-day uptime">
      {data.slice(-visibleCount).map((day) => {
        const barColor =
          day.status === 'up' ? 'var(--bsp-up)' :
          day.status === 'down' ? 'var(--bsp-down)' :
          day.status === 'degraded' ? 'var(--bsp-degraded)' : 'var(--bsp-card-border)'
        return (
          <div
            key={day.date}
            className="w-1.5 h-4 rounded-sm flex-shrink-0"
            style={{ background: barColor }}
            title={day.status === 'no-data' ? `${day.date}: No Data` : `${day.date}: ${day.uptimePct.toFixed(1)}%`}
          />
        )
      })}
    </div>
  )
}
