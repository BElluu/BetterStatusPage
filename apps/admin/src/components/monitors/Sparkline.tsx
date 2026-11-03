import type { MonitorStatus } from '@bsp/shared'

const W = 64
const H = 20
const PAD = 3

const TONE: Record<string, string> = {
  up: 'var(--m3-up-bar)',
  degraded: 'var(--m3-degraded-bar)',
  affected: 'var(--m3-degraded-bar)',
  down: 'var(--m3-down)',
  pending: 'var(--m3-outline)',
}

/**
 * A small trend line: area fill, line and an emphasised last point. A null value is an hour without a timed check
 * and leaves a gap in the line. Draws nothing when fewer than two points exist.
 */
export function Sparkline({ values, status, label }: { values: ReadonlyArray<number | null>; status: MonitorStatus; label: string }) {
  const points = values
    .map((value, i) => (value === null ? null : { i, value }))
    .filter((p): p is { i: number; value: number } => p !== null)
  if (points.length < 2) return <span className="inline-block" style={{ width: W, height: H }} aria-hidden="true" />

  const max = Math.max(...points.map((p) => p.value), 1)
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / Math.max(values.length - 1, 1)
  const y = (value: number) => H - PAD - (value / max) * (H - 2 * PAD)
  const color = TONE[status] ?? TONE.up!

  // One path segment per run of consecutive points, so a missing hour breaks the line.
  const runs: Array<typeof points> = []
  for (const p of points) {
    const run = runs[runs.length - 1]
    if (run && run[run.length - 1]!.i === p.i - 1) run.push(p)
    else runs.push([p])
  }
  const line = (run: typeof points) => run.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ')
  const last = points[points.length - 1]!

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="shrink-0">
      {runs.filter((run) => run.length > 1).map((run, k) => (
        <path key={`a${k}`} d={`${line(run)} L${x(run[run.length - 1]!.i).toFixed(1)} ${H - PAD} L${x(run[0]!.i).toFixed(1)} ${H - PAD} Z`} fill={color} fillOpacity={0.16} />
      ))}
      {runs.map((run, k) => (
        <path key={`l${k}`} d={line(run)} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      <circle cx={x(last.i)} cy={y(last.value)} r={2.2} fill={color} />
    </svg>
  )
}
