import { lazy, Suspense, useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type {
  LayoutTree, LayoutNode, GroupNode, MonitorNode, TextNode,
  IncidentsNode, ChartNode, PublicMonitor, MonitorStatus, Incident,
} from '@bsp/shared'
import Markdown from 'react-markdown'
import { IncidentCard } from './IncidentCard'
import { useLocale } from '../i18n/LocaleContext'
const ResponseTimeChart = lazy(() => import('./ResponseTimeChart').then((m) => ({ default: m.ResponseTimeChart })))
import { applyIncidentStatus } from '../utils/incidentStatus'
import { useMonitorUptime, type UptimeDay } from '../hooks/useMonitorUptime'

interface StatusInfo {
  status: MonitorStatus
  responseMs: number | null
  checkedAt: number
}

interface Props {
  tree: LayoutTree
  monitors: PublicMonitor[]
  statusMap: Record<number, StatusInfo>
  activeIncidents?: Incident[]
  allIncidents?: Incident[]
  maintenanceMonitorIds?: Set<number>
  dependencyMap?: Record<number, number[]>
}

export function PageRenderer({
  tree, monitors, statusMap,
  activeIncidents = [], allIncidents = [],
  maintenanceMonitorIds = new Set(),
  dependencyMap = {},
}: Props) {
  const sorted = [...tree.children].sort((a, b) => {
    const ay = a.grid?.y ?? 0, ax = a.grid?.x ?? 0
    const by = b.grid?.y ?? 0, bx = b.grid?.x ?? 0
    return ay !== by ? ay - by : ax - bx
  })

  return (
    <section className="bsp-layout-grid">
      {sorted.map((node) => (
        <div
          key={node.id}
          className="bsp-layout-cell"
          style={{
            gridColumn: `${(node.grid?.x ?? 0) + 1} / span ${node.grid?.w ?? 3}`,
            gridRow: `${(node.grid?.y ?? 0) + 1} / span ${node.grid?.h ?? 1}`,
            minWidth: 0,
            alignSelf: 'start',
          }}
        >
          <NodeRenderer
            node={node}
            monitors={monitors}
            statusMap={statusMap}
            activeIncidents={activeIncidents}
            allIncidents={allIncidents}
            maintenanceMonitorIds={maintenanceMonitorIds}
            dependencyMap={dependencyMap}
          />
        </div>
      ))}
    </section>
  )
}

function NodeRenderer({
  node, monitors, statusMap, activeIncidents, allIncidents, maintenanceMonitorIds, dependencyMap,
}: {
  node: LayoutNode
  monitors: PublicMonitor[]
  statusMap: Record<number, StatusInfo>
  activeIncidents: Incident[]
  allIncidents: Incident[]
  maintenanceMonitorIds: Set<number>
  dependencyMap: Record<number, number[]>
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
    const liveMonitor = {
      ...monitor,
      currentStatus: applyIncidentStatus(live?.status ?? monitor.currentStatus, monitor.id, activeIncidents),
    }
    const inMaintenance = maintenanceMonitorIds.has(monitor.id)
    const causingIds = liveMonitor.currentStatus === 'affected' ? (dependencyMap[monitor.id] ?? []) : []
    const causingMonitors = causingIds.map((id) => monitors.find((m) => m.id === id)).filter(Boolean) as PublicMonitor[]

    if ((monNode.cardVariant ?? 'default') === 'compact') {
      return (
        <CompactMonitorRow
          monitor={liveMonitor}
          responseMs={live?.responseMs ?? null}
          showMonitorType={monNode.showMonitorType ?? false}
          inMaintenance={inMaintenance}
          causingMonitors={causingMonitors}
        />
      )
    }

    return (
      <ServiceMonitorCard
        monitor={liveMonitor}
        responseMs={live?.responseMs ?? null}
        monitorId={monitor.id}
        showUptimeBar={monNode.showUptimeBar}
        showMonitorType={monNode.showMonitorType ?? false}
        uptimeBarPosition={monNode.uptimeBarPosition ?? 'right'}
        showUptimePct={monNode.showUptimePct ?? false}
        gridW={monNode.grid?.w ?? 3}
        inMaintenance={inMaintenance}
        causingMonitors={causingMonitors}
      />
    )
  }

  if (node.type === 'group') {
    return (
      <GroupBlock
        groupNode={node as GroupNode}
        monitors={monitors}
        statusMap={statusMap}
        maintenanceMonitorIds={maintenanceMonitorIds}
        dependencyMap={dependencyMap}
        activeIncidents={activeIncidents}
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

  if (node.type === 'chart') {
    return <ChartBlock node={node as ChartNode} monitors={monitors} />
  }

  return null
}

function ChartBlock({ node: n, monitors }: { node: ChartNode; monitors: PublicMonitor[] }) {
  const { t } = useLocale()
  const monitor = monitors.find((m) => m.id === n.monitorId)
  const rowH = 44
  const heightPx = (n.chartH ?? 5) * rowH + ((n.chartH ?? 5) - 1) * 10
  const period = n.hours <= 24 ? t('chart.lastHours', { n: n.hours }) : t('chart.lastDays', { n: Math.round(n.hours / 24) })
  return (
    <div
      className="bsp-chart-card"
      style={{
        background: 'var(--bsp-chart-bg)',
        border: '1px solid var(--bsp-card-border)',
        borderRadius: '16px',
        padding: '16px 12px 12px',
        height: heightPx,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ width: 48, flexShrink: 0 }}>
          {n.showMonitorType && monitor && (
            <span
              className="font-mono text-[10px] uppercase flex-shrink-0 px-1.5 py-0.5 rounded"
              style={{ color: 'var(--m3-secondary)', background: 'var(--m3-surface-container)' }}
            >
              {monitor.type}
            </span>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--m3-on-surface)', fontFamily: 'Manrope, sans-serif', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {n.title || monitor?.name || t('chart.monitorFallback', { id: n.monitorId })}
          </span>
          <span style={{ fontSize: 11, color: 'var(--m3-secondary)', flexShrink: 0 }}>
            {t(`chart.${n.aggregation}`).toUpperCase()} · {period}
          </span>
        </div>
      </div>
      <div style={{ height: heightPx - 52 }}>
        <Suspense fallback={null}>
          <ResponseTimeChart
            monitorId={n.monitorId}
            hours={n.hours}
            buckets={n.buckets}
            aggregation={n.aggregation}
            showArea={n.showArea ?? true}
          />
        </Suspense>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────
   SERVICE MONITOR CARD  (large variant — matches design exactly)
   ───────────────────────────────────────────────────────────────────── */
interface StatusBadgeProps {
  label: string
  /** Dot and tint colour. */
  color: string
  /** Label colour, darker than `color` so the text stays readable on the tint. */
  textColor: string
  background: string
  /** Down and degraded monitors get a pulsing marker. */
  pulse: boolean
}

/** Colours for one monitor status: vivid for dots and tints, high-contrast for text. */
function statusColors(status: MonitorStatus): { color: string; textColor: string; background: string } {
  const tone = status === 'up' ? 'up' : status === 'down' ? 'down' : status === 'degraded' || status === 'affected' ? 'degraded' : null
  if (!tone) return { color: 'var(--m3-secondary)', textColor: 'var(--m3-secondary)', background: 'var(--m3-surface-container)' }
  return {
    color: `var(--bsp-${tone})`,
    textColor: `var(--bsp-${tone}-text)`,
    background: `color-mix(in srgb, var(--bsp-${tone}) 12%, transparent)`,
  }
}

function StatusPill({ label, color, textColor, background, pulse, minWidth }: StatusBadgeProps & { minWidth: string }) {
  return (
    <span
      style={{
        background, color: textColor,
        padding: '6px 14px', borderRadius: '999px',
        fontSize: '13px', fontWeight: 700,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
        flexShrink: 0,
        minWidth,
      }}
    >
      {pulse && (
        <span
          className="animate-pulse"
          style={{ width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }}
        />
      )}
      {label}
    </span>
  )
}

/** Right-position layout: gridW=1 → dot only; gridW=2 → compact pill; gridW≥3 → full pill. */
function StatusBadgeRight({ gridW, ...badge }: StatusBadgeProps & { gridW: number }) {
  if (gridW === 1) {
    return (
      <div style={{ flexShrink: 0, position: 'relative', width: 14, height: 14 }}>
        {badge.pulse && (
          <span className="monitor-dot-ring" style={{ background: badge.color, opacity: 0.4 }} />
        )}
        <span style={{ display: 'block', width: '100%', height: '100%', borderRadius: '50%', background: badge.color }} />
      </div>
    )
  }
  return <StatusPill {...badge} minWidth={gridW === 2 ? '96px' : '114px'} />
}

interface NameBlockProps {
  monitor: PublicMonitor
  showMonitorType: boolean
  inMaintenance: boolean
  /** Upstream monitors to name when this one is affected; empty otherwise. */
  causingMonitors: PublicMonitor[]
  /** Sits beside inline uptime bars, so it is width-capped instead of filling the row. */
  beside: boolean
}

function NameBlock({ monitor, showMonitorType, inMaintenance, causingMonitors, beside }: NameBlockProps) {
  const { t } = useLocale()
  return (
    <div style={{
      minWidth: 0,
      flex: beside ? '0 1 240px' : '1 1 auto',
      maxWidth: beside ? '240px' : 'none',
    }}>
      <h3
        className="font-headline font-bold"
        title={monitor.name}
        style={{ fontSize: '28px', lineHeight: 1.15, color: 'var(--bsp-text)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingBottom: '3px' }}
      >
        {monitor.name}
      </h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
        {showMonitorType && (
          <p
            className="font-mono uppercase"
            style={{ fontSize: '11px', letterSpacing: '0.09em', color: 'var(--m3-secondary)', margin: 0 }}
          >
            {monitor.type.toUpperCase()}
          </p>
        )}
        {inMaintenance && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '3px',
            fontSize: '10px', fontWeight: 700, letterSpacing: '0.04em',
            padding: '2px 7px', borderRadius: '999px',
            background: 'var(--bsp-maintenance-chip-bg)', color: 'var(--bsp-maintenance-text)',
          }}>
            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '11px' }}>construction</span>
            <span style={{ textTransform: 'uppercase' }}>{t('page.maintenance')}</span>
          </span>
        )}
        {causingMonitors.length > 0 && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '3px',
            fontSize: '10px', fontWeight: 600, letterSpacing: '0.03em',
            padding: '2px 7px', borderRadius: '999px',
            background: 'color-mix(in srgb, var(--bsp-degraded) 18%, transparent)', color: 'var(--bsp-degraded-text)',
          }}>
            <span className="material-symbols-outlined" style={{ fontSize: '11px' }}>link</span>
            {t('status.affectedBy')}: {causingMonitors.map((m) => m.name).join(', ')}
          </span>
        )}
      </div>
    </div>
  )
}

function ServiceMonitorCard({
  monitor, responseMs: _responseMs, monitorId,
  showUptimeBar, showMonitorType = false,
  uptimeBarPosition = 'right',
  showUptimePct = false,
  gridW = 3,
  inMaintenance = false,
  causingMonitors = [],
}: {
  monitor: PublicMonitor
  responseMs: number | null
  monitorId: number
  showUptimeBar: boolean
  showMonitorType?: boolean
  uptimeBarPosition?: 'right' | 'below'
  showUptimePct?: boolean
  gridW?: number
  inMaintenance?: boolean
  causingMonitors?: PublicMonitor[]
}) {
  const [overallPct, setOverallPct] = useState<number | null | undefined>(undefined)

  const { t } = useLocale()
  const isUp       = monitor.currentStatus === 'up'
  const isDown     = monitor.currentStatus === 'down'
  const isDegraded = monitor.currentStatus === 'degraded'
  const isAffected = monitor.currentStatus === 'affected'

  const statusLabel   = isUp ? t('status.operational') : isDown ? t('status.outage') : isDegraded ? t('status.degraded') : isAffected ? t('status.affected') : t('status.checking')

  const uptimeLabel = showUptimePct && overallPct !== undefined
    ? overallPct === null ? t('uptime.noData') : t('uptime.pct', { pct: overallPct.toFixed(1) })
    : null

  const badgeProps: StatusBadgeProps = { label: statusLabel, ...statusColors(monitor.currentStatus), pulse: isDown || isDegraded }
  const nameProps: NameBlockProps = {
    monitor, showMonitorType, inMaintenance,
    causingMonitors: isAffected ? causingMonitors : [],
    beside: showUptimeBar && uptimeBarPosition === 'right',
  }

  /* ── Right: bars fill the gap between name and badge ── */
  if (showUptimeBar && uptimeBarPosition === 'right') {
    return (
      <div className="bsp-monitor-card" style={{ padding: '28px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <NameBlock {...nameProps} />
          <UptimeBarsInline monitorId={monitorId} />
          <StatusBadgeRight {...badgeProps} gridW={gridW} />
        </div>
      </div>
    )
  }

  /* ── Below: stacked layout ── */
  return (
    <div className="bsp-monitor-card" style={{ padding: '28px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: showUptimeBar ? '20px' : '0', gap: '16px' }}>
        <NameBlock {...nameProps} />
        <StatusPill {...badgeProps} minWidth="114px" />
      </div>

      {showUptimeBar && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '10px', fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--m3-secondary)' }}>
              {t('uptime.daysAgo', { n: 30 })}
            </span>
            {uptimeLabel && (
              <span style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--m3-on-surface)' }}>
                {uptimeLabel}
              </span>
            )}
            <span style={{ fontSize: '10px', fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--m3-secondary)' }}>
              {t('uptime.today')}
            </span>
          </div>
          <UptimeBars monitorId={monitorId} onData={setOverallPct} />
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────
   COMPACT MONITOR ROW  (slim — for compact variant and group children)
   ───────────────────────────────────────────────────────────────────── */
function CompactMonitorRow({
  monitor, responseMs: _responseMs, showMonitorType = false, nested = false, inMaintenance = false, causingMonitors = [],
}: {
  monitor: PublicMonitor
  responseMs: number | null
  showMonitorType?: boolean
  nested?: boolean
  inMaintenance?: boolean
  causingMonitors?: PublicMonitor[]
}) {
  const { t } = useLocale()
  const isUp       = monitor.currentStatus === 'up'
  const isDown     = monitor.currentStatus === 'down'
  const isDegraded = monitor.currentStatus === 'degraded'
  const isAffected = monitor.currentStatus === 'affected'

  const statusLabel = isUp ? t('status.operational') : isDown ? t('status.outage') : isDegraded ? t('status.degraded') : isAffected ? t('status.affected') : t('status.checking')
  const { color: dotColor, textColor: statusTextColor, background: statusBg } = statusColors(monitor.currentStatus)

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
        {(isDown || isDegraded || isAffected) && (
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

      {/* Name + caused-by chip (stacked when affected) */}
      <span className="bsp-monitor-name font-sans font-medium text-sm flex-1 min-w-0" style={{ color: 'var(--bsp-text)' }}>
        <span className="truncate block" title={monitor.name}>{monitor.name}</span>
        {isAffected && causingMonitors.length > 0 && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '3px',
            fontSize: '10px', fontWeight: 600,
            color: 'var(--bsp-degraded-text)', marginTop: '2px',
          }}>
            <span className="material-symbols-outlined" style={{ fontSize: '10px' }}>link</span>
            {t('status.affectedBy')}: {causingMonitors.map((m) => m.name).join(', ')}
          </span>
        )}
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

      {/* Maintenance chip */}
      {inMaintenance && (
        <span
          role="img"
          aria-label={t('page.maintenance')}
          title={t('page.maintenance')}
          className="flex-shrink-0 flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full"
          style={{ background: 'var(--bsp-maintenance-chip-bg)', color: 'var(--bsp-maintenance-text)' }}
        >
          <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '11px' }}>construction</span>
        </span>
      )}

      {/* Status badge */}
      <span
        className="text-xs font-sans font-semibold px-2.5 py-1 rounded-full flex-shrink-0"
        style={{ background: statusBg, color: statusTextColor }}
      >
        {statusLabel}
      </span>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────
   GROUP BLOCK  (header with aggregate + compact child rows)
   ───────────────────────────────────────────────────────────────────── */
function GroupBlock({ groupNode, monitors, statusMap, activeIncidents, maintenanceMonitorIds = new Set(), dependencyMap = {} }: {
  groupNode: GroupNode
  monitors: PublicMonitor[]
  statusMap: Record<number, StatusInfo>
  activeIncidents: Incident[]
  maintenanceMonitorIds?: Set<number>
  dependencyMap?: Record<number, number[]>
}) {
  const [collapsed, setCollapsed] = useState(false)

  const liveMonitors = groupNode.children
    .filter((c) => c.type === 'monitor')
    .map((c) => {
      const monNode = c as MonitorNode
      const m = monitors.find((mon) => mon.id === monNode.monitorId)
      if (!m) return null
      return {
        ...m,
        currentStatus: applyIncidentStatus(statusMap[m.id]?.status ?? m.currentStatus, m.id, activeIncidents),
      }
    })
    .filter(Boolean) as PublicMonitor[]

  const { t } = useLocale()
  const allDown     = liveMonitors.length > 0 && liveMonitors.every((m) => m.currentStatus === 'down' || m.currentStatus === 'affected')
  const someDown    = !allDown && liveMonitors.some((m) => m.currentStatus === 'down' || m.currentStatus === 'affected')
  const anyDegraded = liveMonitors.some((m) => m.currentStatus === 'degraded')
  const aggStatus   = allDown ? 'down' : someDown ? 'partial' : anyDegraded ? 'degraded' : 'up'

  const aggTone     = aggStatus === 'up' ? 'up' : aggStatus === 'down' ? 'down' : 'degraded'
  const aggDotColor = `var(--bsp-${aggTone})`
  const aggTextColor = `var(--bsp-${aggTone}-text)`
  const aggBg       = `color-mix(in srgb, ${aggDotColor} 12%, transparent)`
  const aggLabel    = aggStatus === 'up' ? t('status.operational') : aggStatus === 'down' ? t('status.outage') : aggStatus === 'partial' ? t('status.partialOutage') : t('status.degraded')

  const Header = groupNode.collapsible ? 'button' : 'div'
  const headerProps = groupNode.collapsible
    ? { type: 'button' as const, 'aria-expanded': !collapsed, onClick: () => setCollapsed(!collapsed) }
    : {}

  return (
    <div
      className="bsp-group-card overflow-hidden"
      style={{ borderRadius: '1rem' }}
    >
      {/* Header */}
      <Header
        {...headerProps}
        className="bsp-group-header w-full text-left flex items-center justify-between gap-3 px-5 py-4"
        style={{
          cursor: groupNode.collapsible ? 'pointer' : 'default',
          userSelect: 'none',
        }}
      >
        <span className="flex items-center gap-3 min-w-0 flex-wrap">
          <span className="relative flex-shrink-0 block" style={{ width: 10, height: 10 }}>
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
          </span>
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
            {t('page.groupServiceCount', { n: liveMonitors.length })}
          </span>
        </span>

        <span className="flex items-center gap-2 flex-shrink-0">
          <span
            className="text-xs font-sans font-semibold px-2.5 py-1 rounded-full"
            style={{ background: aggBg, color: aggTextColor }}
          >
            {aggLabel}
          </span>
          {groupNode.collapsible && (
            <span
              className="material-symbols-outlined"
              aria-hidden="true"
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
        </span>
      </Header>

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
              const liveMonitor = {
                ...m,
                currentStatus: applyIncidentStatus(live?.status ?? m.currentStatus, m.id, activeIncidents),
              }
              const isFullCard = (monNode.cardVariant ?? 'compact') === 'default'
              const causingIds = liveMonitor.currentStatus === 'affected' ? (dependencyMap[m.id] ?? []) : []
              const causingMonitors = causingIds.map((id) => monitors.find((mon) => mon.id === id)).filter(Boolean) as PublicMonitor[]

              return (
                <div key={child.id} style={borderStyle}>
                  {isFullCard ? (
                    <div style={{ padding: '12px 16px' }}>
                      <ServiceMonitorCard
                        monitor={liveMonitor}
                        responseMs={live?.responseMs ?? null}
                        monitorId={m.id}
                        showUptimeBar={monNode.showUptimeBar}
                        showMonitorType={monNode.showMonitorType ?? false}
                        uptimeBarPosition={monNode.uptimeBarPosition ?? 'right'}
                        showUptimePct={monNode.showUptimePct ?? false}
                        gridW={groupNode.grid?.w ?? 3}
                        inMaintenance={maintenanceMonitorIds.has(m.id)}
                        causingMonitors={causingMonitors}
                      />
                    </div>
                  ) : (
                    <CompactMonitorRow
                      monitor={liveMonitor}
                      responseMs={live?.responseMs ?? null}
                      showMonitorType={monNode.showMonitorType ?? false}
                      nested
                      inMaintenance={maintenanceMonitorIds.has(m.id)}
                      causingMonitors={causingMonitors}
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
  monitors: PublicMonitor[]
}) {
  const filter = config.filter ?? 'all'
  const limit  = config.limit ?? 5

  const items = filter === 'active'
    ? activeIncidents
    : filter === 'resolved'
    ? allIncidents.filter((i) => i.status === 'resolved')
    : [...activeIncidents, ...allIncidents.filter((i) => i.status === 'resolved')]

  const shown = items.slice(0, limit)

  if (shown.length === 0) return null

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
function fmtDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function formatUptimeDay(date: string, locale: string): string {
  return new Date(date + 'T12:00:00Z').toLocaleDateString(locale, { month: 'long', day: 'numeric', year: 'numeric' })
}

/** Up days always use the "up" colour, whatever the monitor's current status is. */
function uptimeBarBackground(day: UptimeDay): string {
  return day.status === 'up' ? 'linear-gradient(to top, var(--bsp-up), color-mix(in srgb, var(--bsp-up) 55%, white))'
    : day.status === 'down' ? 'var(--bsp-down)'
    : day.status === 'degraded' ? 'var(--bsp-degraded)'
    : day.status === 'partial' ? 'var(--bsp-partial)'
    : 'var(--m3-outline-variant)'
}

function UptimeTooltip({ day, anchorRect }: { day: UptimeDay; anchorRect: DOMRect }) {
  const { t, locale } = useLocale()
  const W = 232
  const vw = window.innerWidth
  let left = anchorRect.left + anchorRect.width / 2 - W / 2
  left = Math.max(8, Math.min(left, vw - W - 8))
  const bottom = window.innerHeight - anchorRect.top + 10

  const dateLabel = formatUptimeDay(day.date, locale)
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
          {t('uptime.pct', { pct: day.uptimePct.toFixed(1) })}
        </p>
      )}
      {noData && (
        <p style={{ fontSize: '11px', color: 'var(--m3-secondary)', margin: '0 0 6px' }}>
          {t('uptime.noData')}
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
                {inc.durationMs !== null ? t('uptime.resolvedIn', { duration: fmtDuration(inc.durationMs) }) : t('uptime.ongoing')}
              </p>
            </div>
          ))}
        </div>
      ) : !noData && (
        <p style={{ fontSize: '10px', color: 'var(--m3-secondary)', margin: 0, borderTop: '1px solid var(--m3-outline-variant)', paddingTop: '6px' }}>
          {t('uptime.noIncidents')}
        </p>
      )}
    </div>,
    document.body,
  )
}

/**
 * One day of history. It is a button so the tooltip also opens on keyboard focus and on tap,
 * not only on mouse hover; screen readers get the date and uptime from its label.
 */
function UptimeBar({ day, active, radius, onShow, onHide }: {
  day: UptimeDay
  active: boolean
  radius: string
  onShow: (day: UptimeDay, el: HTMLElement) => void
  onHide: () => void
}) {
  const { t, locale } = useLocale()
  const noData = day.status === 'no-data'
  const label = t('uptime.barLabel', {
    date: formatUptimeDay(day.date, locale),
    status: noData ? t('uptime.noData') : t('uptime.pct', { pct: day.uptimePct.toFixed(1) }),
  })
  return (
    <button
      type="button"
      className="bsp-uptime-bar"
      aria-label={label}
      style={{
        flex: 1,
        minWidth: 0,
        height: '100%',
        padding: 0,
        border: 0,
        borderRadius: radius,
        background: uptimeBarBackground(day),
        opacity: noData ? 0.35 : 1,
        cursor: 'default',
        transition: 'filter 0.12s ease, transform 0.12s ease',
        transformOrigin: 'bottom',
        filter: active ? 'brightness(1.5)' : 'brightness(1)',
        transform: active ? 'scaleY(1.08)' : 'scaleY(1)',
      }}
      onMouseEnter={(e) => onShow(day, e.currentTarget)}
      onMouseLeave={onHide}
      onFocus={(e) => onShow(day, e.currentTarget)}
      onBlur={onHide}
      onClick={(e) => onShow(day, e.currentTarget)}
    />
  )
}

/** Neutral placeholder bars while the history loads, so no made-up up or down days are shown. */
function SkeletonBars({ count, radius }: { count: number; radius: string }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          aria-hidden="true"
          style={{ flex: 1, minWidth: 0, height: '100%', borderRadius: radius, background: 'var(--m3-outline-variant)', opacity: 0.3 }}
        />
      ))}
    </>
  )
}

function UptimeUnavailable() {
  const { t } = useLocale()
  return (
    <span style={{ flex: 1, alignSelf: 'center', textAlign: 'center', fontSize: '11px', color: 'var(--m3-secondary)' }}>
      {t('uptime.noData')}
    </span>
  )
}

function useUptimeTooltip() {
  const [hovered, setHovered] = useState<{ day: UptimeDay; rect: DOMRect } | null>(null)
  const show = (day: UptimeDay, el: HTMLElement) => setHovered({ day, rect: el.getBoundingClientRect() })
  const hide = () => setHovered(null)
  return { hovered, show, hide }
}

/* ─────────────────────────────────────────────────────────────────────
   UPTIME BARS — full 40-bar version (below position)
   ───────────────────────────────────────────────────────────────────── */
function UptimeBars({ monitorId, onData }: {
  monitorId: number
  onData?: ((pct: number | null) => void) | undefined
}) {
  const { uptime, failed } = useMonitorUptime(monitorId, 30)
  const { hovered, show, hide } = useUptimeTooltip()

  useEffect(() => {
    if (uptime) onData?.(uptime.overallUptimePct)
  }, [uptime, onData])

  return (
    <>
      {hovered && <UptimeTooltip day={hovered.day} anchorRect={hovered.rect} />}
      <div className="flex h-10 items-end" style={{ gap: '2px' }}>
        {failed ? <UptimeUnavailable />
          : !uptime ? <SkeletonBars count={40} radius="2px" />
          : uptime.days.slice(-40).map((day, i) => (
            <UptimeBar key={day.date ?? i} day={day} radius="2px" active={hovered?.day.date === day.date} onShow={show} onHide={hide} />
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
function UptimeBarsInline({ monitorId }: { monitorId: number }) {
  const { uptime, failed } = useMonitorUptime(monitorId, 30)
  const [barCount, setBarCount] = useState(30)
  const { hovered, show, hide } = useUptimeTooltip()
  const containerRef = useRef<HTMLDivElement>(null)

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

  return (
    <>
      {hovered && <UptimeTooltip day={hovered.day} anchorRect={hovered.rect} />}
      <div
        ref={containerRef}
        style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'stretch', gap: '2px', height: '48px' }}
      >
        {failed ? <UptimeUnavailable />
          : !uptime ? <SkeletonBars count={barCount} radius="3px" />
          : uptime.days.slice(-barCount).map((day, i) => (
            <UptimeBar key={day.date ?? i} day={day} radius="3px" active={hovered?.day.date === day.date} onShow={show} onHide={hide} />
          ))}
      </div>
    </>
  )
}
