import type { MonitorStatus } from '@bsp/shared'

const configs: Record<MonitorStatus, { label: string; className: string }> = {
  up: { label: 'Operational', className: 'bg-emerald-500/15 text-emerald-400' },
  down: { label: 'Down', className: 'bg-red-500/15 text-red-400' },
  degraded: { label: 'Degraded', className: 'bg-amber-500/15 text-amber-400' },
  pending: { label: 'Pending', className: 'bg-slate-500/15 text-slate-400' },
}

export function StatusBadge({ status }: { status: MonitorStatus }) {
  const cfg = configs[status] ?? configs.pending
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full font-medium ${cfg.className}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {cfg.label}
    </span>
  )
}
