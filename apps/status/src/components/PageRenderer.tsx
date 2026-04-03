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
            minWidth: 0,
            overflow: 'hidden',
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
    return (
      <div className="bsp-divider my-5 flex items-center gap-3">
        <span className="flex-1 h-px" style={{ background: 'var(--bsp-card-border)' }} />
      </div>
    )
  }

  if (node.type === 'text') {
    const textNode = node as TextNode
    return (
      <div className="bsp-text-block prose prose-invert prose-sm max-w-none py-2 px-1" style={{ color: 'var(--bsp-text-muted)' }}>
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
        gridW={monNode.grid?.w ?? 1}
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
  const showPulse = aggStatus !== 'up'

  return (
    <div className="bsp-group-card glass overflow-hidden">
      <div
        className={`bsp-group-header flex items-center justify-between px-4 py-3.5 ${groupNode.collapsible ? 'cursor-pointer' : ''}`}
        style={{ transition: 'background 0.15s' }}
        onClick={() => groupNode.collapsible && setCollapsed(!collapsed)}
        onMouseEnter={(e) => groupNode.collapsible && ((e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.03)')}
        onMouseLeave={(e) => groupNode.collapsible && ((e.currentTarget as HTMLDivElement).style.background = '')}
      >
        <div className="flex items-center gap-3">
          <div className="relative flex-shrink-0" style={{ width: 10, height: 10 }}>
            {showPulse && (
              <span
                className="monitor-dot-ring"
                style={{ background: aggColor, opacity: 0.35 }}
              />
            )}
            <span className="block w-full h-full rounded-full" style={{ background: aggColor }} />
          </div>
          <span className="bsp-group-label font-display font-semibold text-sm" style={{ color: 'var(--bsp-text)' }}>
            {groupNode.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium" style={{ color: aggColor }}>{aggLabel}</span>
          {groupNode.collapsible && (
            <span className="text-xs font-mono" style={{ color: 'var(--bsp-text-muted)' }}>
              {collapsed ? '▸' : '▾'}
            </span>
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
                    gridW={groupNode.grid?.w ?? 1}
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
  gridW = 1,
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
  gridW?: number
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
  const showPulse = monitor.currentStatus === 'down' || monitor.currentStatus === 'degraded'

  const outerClass = nested
    ? 'bsp-monitor-card flex flex-col overflow-hidden'
    : 'bsp-monitor-card glass glass-hover flex flex-col overflow-hidden'

  const outerStyle: React.CSSProperties = nested
    ? { padding: '10px 16px 10px 24px' }
    : { padding: '10px 14px' }

  return (
    <div className={outerClass} style={outerStyle}>
      <div className="flex items-center gap-2">
        <span className="bsp-monitor-name text-sm font-medium flex-shrink-0" style={{ color: 'var(--bsp-text)' }}>
          {monitor.name}
        </span>
        {showMonitorType && (
          <span
            className="font-mono text-[10px] uppercase flex-shrink-0 px-1.5 py-0.5 rounded"
            style={{ color: 'var(--bsp-text-muted)', background: 'rgba(255,255,255,0.05)', letterSpacing: '0.05em' }}
          >
            {monitor.type}
          </span>
        )}
        {showResponseTime && responseMs !== null && (
          <span className="font-mono text-xs flex-shrink-0" style={{ color: 'var(--bsp-text-muted)' }}>
            {responseMs}ms
          </span>
        )}
        {showUptimeBar && uptimeBarPosition === 'right' && (
          <div className="bsp-uptime-bar flex-1 overflow-hidden min-w-0">
            <UptimeBar monitorId={monitorId} />
          </div>
        )}
        {(!showUptimeBar || uptimeBarPosition === 'below') && <div className="flex-1" />}
        <div className="bsp-monitor-status flex items-center gap-1.5 flex-shrink-0">
          <div className="relative flex-shrink-0" style={{ width: 8, height: 8 }}>
            {showPulse && (
              <span
                className="monitor-dot-ring"
                style={{ background: color, opacity: 0.4 }}
              />
            )}
            <span className="block w-full h-full rounded-full" style={{ background: color }} />
          </div>
          <span className="text-xs font-medium" style={{ color }}>{label}</span>
        </div>
      </div>

      {showUptimeBar && uptimeBarPosition === 'below' && (
        <div className="bsp-uptime-bar mt-2">
          <UptimeBar monitorId={monitorId} fill onData={showUptimePct ? setOverallPct : undefined} />
          {showUptimePct && overallPct !== null && (
            gridW <= 1 ? (
              <div className="mt-1 text-center font-mono" style={{ color: 'var(--bsp-text-muted)', fontSize: '0.6rem' }}>
                {overallPct.toFixed(2)}% uptime
              </div>
            ) : (
              <div className="flex items-center mt-1 font-mono" style={{ gap: '4px' }}>
                <span style={{ color: 'var(--bsp-text-muted)', fontSize: '0.6rem', flexShrink: 0 }}>30 days ago</span>
                <div style={{ flex: 1, height: '1px', background: 'var(--bsp-card-border)' }} />
                <span style={{ color: 'var(--bsp-text-muted)', fontSize: '0.6rem', flexShrink: 0 }}>
                  {overallPct.toFixed(2)}% uptime
                </span>
                <div style={{ flex: 1, height: '1px', background: 'var(--bsp-card-border)' }} />
                <span style={{ color: 'var(--bsp-text-muted)', fontSize: '0.6rem', flexShrink: 0 }}>today</span>
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}

function UptimeBar({ monitorId, onData, fill = false }: { monitorId: number; onData?: (pct: number) => void; fill?: boolean }) {
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
      const count = Math.floor((entry.contentRect.width + 2) / 8)
      setVisibleCount(Math.min(30, Math.max(0, count)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  if (!data) return null

  const barColor = (day: { status: string }) =>
    day.status === 'up' ? 'var(--bsp-up)' :
    day.status === 'down' ? 'var(--bsp-down)' :
    day.status === 'degraded' ? 'var(--bsp-degraded)' : 'rgba(255,255,255,0.08)'

  if (fill) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(30, 1fr)', gap: '2px' }}>
        {data.slice(-30).map((day) => (
          <div
            key={day.date}
            className="rounded-sm"
            style={{ background: barColor(day), height: '14px' }}
            title={day.status === 'no-data' ? `${day.date}: No Data` : `${day.date}: ${day.uptimePct.toFixed(1)}%`}
          />
        ))}
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex gap-0.5 items-center justify-end" title="30-day uptime">
      {data.slice(-visibleCount).map((day) => (
        <div
          key={day.date}
          className="rounded-sm flex-shrink-0"
          style={{ background: barColor(day), width: '6px', height: '14px' }}
          title={day.status === 'no-data' ? `${day.date}: No Data` : `${day.date}: ${day.uptimePct.toFixed(1)}%`}
        />
      ))}
    </div>
  )
}
