import { Area, AreaChart, CartesianGrid, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { MonitorStats } from '@bsp/shared'

export type ChartMetric = 'avg' | 'p95' | 'max'

interface Point {
  ts: number
  value: number | null
  avg: number | null
  p95: number | null
  min: number | null
  max: number | null
  count: number
  status: 'up' | 'degraded' | 'down' | null
}

function toPoints(stats: MonitorStats, metric: ChartMetric): Point[] {
  return stats.buckets.map((b) => ({
    ts: b.ts,
    value: metric === 'avg' ? b.avgMs : metric === 'p95' ? b.p95Ms : b.maxMs,
    avg: b.avgMs, p95: b.p95Ms, min: b.minMs, max: b.maxMs,
    count: b.checksTotal,
    status: b.checksTotal === 0 ? null : b.down > 0 ? 'down' : b.degraded > 0 ? 'degraded' : 'up',
  }))
}

/** Consecutive down or degraded buckets grouped into one shaded range each. */
function badRanges(points: Point[]) {
  const ranges: Array<{ start: number; end: number; type: 'down' | 'degraded' }> = []
  let current: (typeof ranges)[number] | null = null
  for (const point of points) {
    if (point.status === 'down' || point.status === 'degraded') {
      if (current && current.type === point.status) current.end = point.ts
      else {
        if (current) ranges.push(current)
        current = { start: point.ts, end: point.ts, type: point.status }
      }
    } else if (current) {
      ranges.push(current)
      current = null
    }
  }
  if (current) ranges.push(current)
  return ranges
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}

const STATUS_LABEL = { up: 'Operational', degraded: 'Degraded', down: 'Down' } as const
const STATUS_TONE = { up: 'var(--m3-up)', degraded: 'var(--m3-degraded)', down: 'var(--m3-down)' } as const
const STATUS_DOT = { up: 'var(--m3-up-bar)', degraded: 'var(--m3-degraded-bar)', down: 'var(--m3-down)' } as const

function xTick(ts: number, hours: number): string {
  const date = new Date(ts)
  return hours <= 24
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChartTooltip({ active, payload, hours }: { active?: boolean; payload?: readonly any[]; hours: number }) {
  const point = payload?.[0]?.payload as Point | undefined
  if (!active || !point || point.count === 0) return null
  const label = new Date(point.ts).toLocaleString(undefined, hours <= 24
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  const rows: Array<[string, number | null]> = [['Avg', point.avg], ['p95', point.p95], ['Min', point.min], ['Max', point.max]]
  return (
    <div style={{
      background: 'var(--m3-surface-container-high)', border: '1px solid var(--m3-outline-variant)', borderRadius: 10,
      padding: '10px 13px', fontSize: 12, boxShadow: '0 4px 16px rgba(0,0,0,0.18)', minWidth: 160,
    }}>
      <p style={{ fontWeight: 700, color: 'var(--m3-on-surface)', marginBottom: 6 }}>{label}</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px' }}>
        {rows.filter(([, v]) => v !== null).map(([name, v]) => (
          <span key={name} style={{ display: 'contents' }}>
            <span style={{ color: 'var(--m3-secondary)' }}>{name}</span>
            <span style={{ color: 'var(--m3-on-surface)', fontWeight: 600, textAlign: 'right' }}>{formatMs(v!)}</span>
          </span>
        ))}
      </div>
      {point.status && (
        <div style={{ marginTop: 6, borderTop: '1px solid var(--m3-outline-variant)', paddingTop: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_DOT[point.status], display: 'inline-block' }} />
          <span style={{ color: STATUS_TONE[point.status], fontWeight: 600 }}>{STATUS_LABEL[point.status]}</span>
          <span style={{ color: 'var(--m3-secondary)', marginLeft: 'auto' }}>{point.count} {point.count === 1 ? 'check' : 'checks'}</span>
        </div>
      )}
    </div>
  )
}

interface Props {
  stats: MonitorStats
  metric: ChartMetric
  height?: number
}

/** Response time of one monitor, drawn like the chart on the public status page. */
export function ResponseTimeChart({ stats, metric, height = 300 }: Props) {
  const points = toPoints(stats, metric)
  const values = points.map((p) => p.value).filter((v): v is number => v !== null)
  if (values.length === 0) {
    return <p role="status" className="text-sm py-10 text-center" style={{ color: 'var(--m3-secondary)' }}>No response times in this range.</p>
  }

  const yMax = Math.ceil(Math.max(...values) * 1.15)
  const step = Math.max(1, Math.floor(points.length / 5))
  const ticks = points.filter((_, i) => i % step === 0).map((p) => p.ts)
  const gradientId = `monitor-chart-${stats.monitorId}`

  return (
    <div role="img" aria-label="Response time chart" style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--m3-primary)" stopOpacity={0.22} />
              <stop offset="95%" stopColor="var(--m3-primary)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--m3-outline-variant)" vertical={false} />
          <XAxis
            dataKey="ts" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={ticks}
            tickFormatter={(v: number) => xTick(v, stats.hours)}
            tick={{ fontSize: 10, fill: 'var(--m3-secondary)' }} axisLine={false} tickLine={false}
          />
          <YAxis
            domain={[0, yMax]} tickFormatter={formatMs} width={48}
            tick={{ fontSize: 10, fill: 'var(--m3-secondary)' }} axisLine={false} tickLine={false}
          />
          <Tooltip content={(p) => <ChartTooltip {...p} hours={stats.hours} />} />
          {badRanges(points).map((range, i) => (
            <ReferenceArea
              key={i} x1={range.start} x2={range.end} stroke="none"
              fill={`color-mix(in srgb, ${range.type === 'down' ? 'var(--m3-down)' : 'var(--m3-degraded-bar)'} 12%, transparent)`}
            />
          ))}
          <Area
            type="monotone" dataKey="value" stroke="var(--m3-primary)" strokeWidth={2} fill={`url(#${gradientId})`}
            dot={false} activeDot={{ r: 4, strokeWidth: 0 }} connectNulls={false} isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
