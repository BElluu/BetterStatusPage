import { useState, useEffect } from 'react'
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
        gridTemplateColumns: 'repeat(12, 1fr)',
        gridAutoRows: '80px',
        gap: '10px',
      }}
    >
      {sorted.map((node) => (
        <div
          key={node.id}
          style={{
            gridColumn: `${(node.grid?.x ?? 0) + 1} / span ${node.grid?.w ?? 12}`,
            gridRow: `span ${node.grid?.h ?? 1}`,
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
    <div
      className="bsp-group-card rounded-xl overflow-hidden flex flex-col h-full"
      style={{ background: 'var(--bsp-card-bg)', border: '1px solid var(--bsp-card-border)' }}
    >
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
        <div className="overflow-y-auto flex-1" style={{ borderTop: '1px solid var(--bsp-card-border)' }}>
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
  monitorId,
  nested = false,
}: {
  monitor: Monitor
  responseMs: number | null
  showUptimeBar: boolean
  showResponseTime: boolean
  uptimeBarPosition?: 'right' | 'below'
  monitorId: number
  nested?: boolean
}) {
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
    : { background: 'var(--bsp-card-bg)', border: '1px solid var(--bsp-card-border)', borderRadius: '8px', padding: '10px 14px' }

  return (
    <div className="bsp-monitor-card flex flex-col" style={outerStyle}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
          <span className="bsp-monitor-name text-sm" style={{ color: 'var(--bsp-text)' }}>{monitor.name}</span>
          <span
            className="bsp-monitor-type text-xs uppercase px-1.5 py-0.5 rounded"
            style={{ color: 'var(--bsp-text-muted)', background: 'rgba(148,163,184,0.08)' }}
          >
            {monitor.type}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {showResponseTime && responseMs !== null && (
            <span style={{ color: 'var(--bsp-text-muted)' }}>{responseMs}ms</span>
          )}
          {showUptimeBar && uptimeBarPosition === 'right' && <UptimeBar monitorId={monitorId} />}
          <span className="bsp-monitor-status" style={{ color }}>{label}</span>
        </div>
      </div>
      {showUptimeBar && uptimeBarPosition === 'below' && (
        <div className="mt-2 pl-5">
          <UptimeBar monitorId={monitorId} />
        </div>
      )}
    </div>
  )
}

function UptimeBar({ monitorId }: { monitorId: number }) {
  const [data, setData] = useState<Array<{ date: string; status: string; uptimePct: number }> | null>(null)

  useEffect(() => {
    fetch(`/api/v1/public/monitor/${monitorId}/uptime?days=30`)
      .then((r) => r.json())
      .then((res: { days: Array<{ date: string; status: string; uptimePct: number }> }) => setData(res.days))
      .catch(() => {})
  }, [monitorId])

  if (!data) return null

  return (
    <div className="bsp-uptime-bar flex gap-0.5 items-center" title="30-day uptime">
      {data.slice(-30).map((day) => {
        const color =
          day.status === 'up' ? 'var(--bsp-up)' :
          day.status === 'down' ? 'var(--bsp-down)' :
          day.status === 'degraded' ? 'var(--bsp-degraded)' : 'var(--bsp-card-border)'
        return (
          <div
            key={day.date}
            className="w-1.5 h-5 rounded-sm"
            style={{ background: color }}
            title={`${day.date}: ${day.uptimePct.toFixed(1)}% uptime`}
          />
        )
      })}
    </div>
  )
}
