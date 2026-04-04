import type { MonitorStatus } from '@bsp/shared'

const configs: Record<MonitorStatus, { label: string; color: string; bg: string }> = {
  up:       { label: 'Operational', color: 'var(--m3-up)',       bg: 'var(--m3-up-bg)' },
  down:     { label: 'Down',        color: 'var(--m3-down)',     bg: 'var(--m3-down-bg)' },
  degraded: { label: 'Degraded',    color: 'var(--m3-degraded)', bg: 'var(--m3-degraded-bg)' },
  pending:  { label: 'Pending',     color: 'var(--m3-secondary)', bg: 'var(--m3-surface-container)' },
}

export function StatusBadge({ status }: { status: MonitorStatus }) {
  const cfg = configs[status] ?? configs.pending
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-sans font-semibold px-2.5 py-0.5 rounded-full"
      style={{ background: cfg.bg, color: cfg.color }}
    >
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: cfg.color }} />
      {cfg.label}
    </span>
  )
}
