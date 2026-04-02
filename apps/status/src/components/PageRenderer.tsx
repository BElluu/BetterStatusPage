import { useState } from 'react'
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
  // Sort by grid position (row-major), then render in a 12-column CSS grid
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
        gap: '10px',
      }}
    >
      {sorted.map((node) => (
        <div
          key={node.id}
          style={{
            gridColumn: `${(node.grid?.x ?? 0) + 1} / span ${node.grid?.w ?? 12}`,
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
    return <hr className="border-slate-800 my-4" />
  }

  if (node.type === 'text') {
    const textNode = node as TextNode
    return (
      <div className="prose prose-invert prose-sm max-w-none py-2">
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
        monitorId={monitor.id}
      />
    )
  }

  if (node.type === 'group') {
    const groupNode = node as GroupNode
    return (
      <GroupBlock groupNode={groupNode} monitors={monitors} statusMap={statusMap} />
    )
  }

  return null
}

function GroupBlock({ groupNode, monitors, statusMap }: { groupNode: GroupNode; monitors: Monitor[]; statusMap: Record<number, StatusInfo> }) {
  const [collapsed, setCollapsed] = useState(false)

  // Aggregate status for the group
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
  const aggColor = { up: '#10b981', down: '#ef4444', degraded: '#f59e0b' }[aggStatus]

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div
        className={`flex items-center justify-between px-4 py-3 ${groupNode.collapsible ? 'cursor-pointer hover:bg-slate-800/50' : ''}`}
        onClick={() => groupNode.collapsible && setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-3">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: aggColor }} />
          <span className="font-medium text-white">{groupNode.label}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: aggColor }}>
            {aggStatus === 'up' ? 'Operational' : aggStatus === 'down' ? 'Outage' : 'Degraded'}
          </span>
          {groupNode.collapsible && (
            <span className="text-slate-500 text-sm">{collapsed ? '▸' : '▾'}</span>
          )}
        </div>
      </div>

      {!collapsed && groupNode.children.length > 0 && (
        <div className="border-t border-slate-800 divide-y divide-slate-800/50">
          {groupNode.children.map((child) => {
            if (child.type === 'monitor') {
              const monNode = child as MonitorNode
              const monitor = monitors.find((m) => m.id === monNode.monitorId)
              if (!monitor) return null
              const live = statusMap[monitor.id]
              return (
                <MonitorRow
                  key={child.id}
                  monitor={{ ...monitor, currentStatus: live?.status ?? monitor.currentStatus }}
                  responseMs={live?.responseMs ?? null}
                  showUptimeBar={monNode.showUptimeBar}
                  showResponseTime={monNode.showResponseTime}
                  monitorId={monitor.id}
                  nested
                />
              )
            }
            return (
              <div key={child.id} className="px-4">
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
  monitorId,
  nested = false,
}: {
  monitor: Monitor
  responseMs: number | null
  showUptimeBar: boolean
  showResponseTime: boolean
  monitorId: number
  nested?: boolean
}) {
  const statusConfig: Record<string, { dot: string; label: string }> = {
    up: { dot: '#10b981', label: 'Operational' },
    down: { dot: '#ef4444', label: 'Down' },
    degraded: { dot: '#f59e0b', label: 'Degraded' },
    pending: { dot: '#64748b', label: 'Checking' },
  }
  const cfg = statusConfig[monitor.currentStatus] ?? statusConfig['pending']!

  return (
    <div className={`flex items-center justify-between py-3 ${nested ? 'px-6' : 'px-4 bg-slate-900 rounded-lg border border-slate-800'}`}>
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: cfg.dot }} />
        <span className="text-white text-sm">{monitor.name}</span>
        <span className="text-xs text-slate-500 uppercase bg-slate-800/80 px-1.5 py-0.5 rounded">{monitor.type}</span>
      </div>
      <div className="flex items-center gap-3 text-xs">
        {showResponseTime && responseMs !== null && (
          <span className="text-slate-500">{responseMs}ms</span>
        )}
        {showUptimeBar && <UptimeBar monitorId={monitorId} />}
        <span style={{ color: cfg.dot }}>{cfg.label}</span>
      </div>
    </div>
  )
}

function UptimeBar({ monitorId }: { monitorId: number }) {
  const [data, setData] = useState<Array<{ date: string; status: string; uptimePct: number }> | null>(null)

  // Lazy load uptime data
  useState(() => {
    fetch(`/api/v1/public/monitor/${monitorId}/uptime?days=30`)
      .then((r) => r.json())
      .then((res: { days: Array<{ date: string; status: string; uptimePct: number }> }) => setData(res.days))
      .catch(() => {})
  })

  if (!data) return null

  return (
    <div className="flex gap-0.5 items-center" title="30-day uptime">
      {data.slice(-30).map((day) => {
        const color =
          day.status === 'up' ? '#10b981' :
          day.status === 'down' ? '#ef4444' :
          day.status === 'degraded' ? '#f59e0b' : '#334155'
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
