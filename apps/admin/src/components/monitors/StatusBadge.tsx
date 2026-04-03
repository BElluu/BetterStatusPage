import type { MonitorStatus } from '@bsp/shared'

const configs: Record<MonitorStatus, { label: string; color: string }> = {
  up:       { label: 'Operational', color: 'var(--sig-teal)' },
  down:     { label: 'Down',        color: 'var(--sig-red)' },
  degraded: { label: 'Degraded',    color: 'var(--sig-amber)' },
  pending:  { label: 'Pending',     color: 'var(--sig-text-muted)' },
}

export function StatusBadge({ status }: { status: MonitorStatus }) {
  const cfg = configs[status] ?? configs.pending
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ background: cfg.color }}
      />
      <span style={{ color: cfg.color }}>{cfg.label}</span>
    </span>
  )
}
