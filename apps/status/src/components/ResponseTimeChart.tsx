import { useEffect, useState } from 'react'
import {
  AreaChart, Area, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceArea, ResponsiveContainer,
} from 'recharts'

export interface HistoryBucket {
  ts: number
  avg: number | null
  min: number | null
  max: number | null
  p95: number | null
  count: number
  status: string | null
}

interface Props {
  monitorId: number
  hours: number
  buckets: number
  aggregation: 'avg' | 'p95' | 'max'
  showArea?: boolean
  title?: string
}

// ── Time-axis label formatter ────────────────────────────────────────────────
function fmtXTick(ts: number, hours: number): string {
  const d = new Date(ts)
  if (hours <= 24) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${ms}ms`
}

// ── Custom tooltip ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChartTooltip({ active, payload, hours }: { active?: boolean; payload?: readonly any[]; hours: number }) {
  if (!active || !payload?.length) return null
  const b = payload[0]?.payload as HistoryBucket | undefined
  if (!b) return null
  if (!b.count) return null

  const d = new Date(b.ts)
  const timeLabel = hours <= 24
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

  const statusColor = b.status === 'down' ? 'var(--bsp-down)' : b.status === 'degraded' ? 'var(--bsp-degraded)' : 'var(--bsp-up)'
  const statusLabel = b.status === 'down' ? 'Down' : b.status === 'degraded' ? 'Degraded' : b.status === 'up' ? 'Up' : b.status ?? '—'

  return (
    <div className="bsp-chart-tooltip" style={{
      background: 'var(--bsp-elevated-bg)',
      border: '1px solid var(--m3-outline-variant)',
      borderRadius: '10px',
      padding: '10px 13px',
      fontSize: '12px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
      minWidth: 160,
    }}>
      <p style={{ fontWeight: 700, color: 'var(--m3-on-surface)', marginBottom: 6 }}>{timeLabel}</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px' }}>
        {b.avg !== null && <Row label="Avg" value={fmtMs(b.avg)} />}
        {b.p95 !== null && <Row label="P95" value={fmtMs(b.p95)} />}
        {b.min !== null && <Row label="Min" value={fmtMs(b.min)} />}
        {b.max !== null && <Row label="Max" value={fmtMs(b.max)} />}
      </div>
      <div style={{ marginTop: 6, borderTop: '1px solid var(--m3-outline-variant)', paddingTop: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, display: 'inline-block' }} />
        <span style={{ color: statusColor, fontWeight: 600 }}>{statusLabel}</span>
        <span style={{ color: 'var(--m3-secondary)', marginLeft: 'auto' }}>{b.count} check{b.count !== 1 ? 's' : ''}</span>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span style={{ color: 'var(--m3-secondary)' }}>{label}</span>
      <span style={{ color: 'var(--m3-on-surface)', fontWeight: 600, textAlign: 'right' }}>{value}</span>
    </>
  )
}

// ── Down/degraded reference areas (group consecutive bad buckets) ──────────
function buildBadRanges(data: HistoryBucket[]) {
  const ranges: Array<{ start: number; end: number; type: 'down' | 'degraded' }> = []
  let current: (typeof ranges)[0] | null = null

  for (const b of data) {
    if (b.status === 'down' || b.status === 'degraded') {
      if (current && current.type === b.status) {
        current.end = b.ts
      } else {
        if (current) ranges.push(current)
        current = { start: b.ts, end: b.ts, type: b.status as 'down' | 'degraded' }
      }
    } else {
      if (current) { ranges.push(current); current = null }
    }
  }
  if (current) ranges.push(current)
  return ranges
}

// ── Main component ────────────────────────────────────────────────────────────
export function ResponseTimeChart({ monitorId, hours, buckets, aggregation, showArea = true, title }: Props) {
  const [data, setData] = useState<HistoryBucket[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const fetchData = () => {
      fetch(`/api/v1/public/monitor/${monitorId}/history?hours=${hours}&buckets=${buckets}`)
        .then((r) => r.json())
        .then((res: { buckets: HistoryBucket[] }) => { if (!cancelled) { setData(res.buckets); setLoading(false) } })
        .catch(() => { if (!cancelled) setLoading(false) })
    }

    setLoading(true)
    fetchData()
    const interval = setInterval(fetchData, 5 * 60_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [monitorId, hours, buckets])

  const aggKey = aggregation as keyof HistoryBucket

  // Determine a reasonable Y-axis domain from data
  const values = (data ?? []).map((b) => b[aggKey] as number | null).filter((v): v is number => v !== null)
  const yMax = values.length ? Math.ceil(Math.max(...values) * 1.15) : 1000
  const yMin = 0

  const badRanges = data ? buildBadRanges(data) : []

  // X-axis: show ~5–6 ticks regardless of bucket count
  const tickStep = data ? Math.max(1, Math.floor(data.length / 5)) : 1
  const ticks = data?.filter((_, i) => i % tickStep === 0).map((b) => b.ts) ?? []

  const chartColor = 'var(--bsp-primary, #6366f1)'

  const commonProps = {
    data: data ?? [],
    margin: { top: 8, right: 8, left: 0, bottom: 0 },
  }

  const xAxis = (
    <XAxis
      dataKey="ts"
      type="number"
      domain={['dataMin', 'dataMax']}
      ticks={ticks}
      tickFormatter={(v) => fmtXTick(v, hours)}
      tick={{ fontSize: 10, fill: 'var(--m3-secondary, #64748b)' }}
      axisLine={false}
      tickLine={false}
      scale="time"
    />
  )

  const yAxis = (
    <YAxis
      domain={[yMin, yMax]}
      tickFormatter={fmtMs}
      tick={{ fontSize: 10, fill: 'var(--m3-secondary, #64748b)' }}
      axisLine={false}
      tickLine={false}
      width={48}
    />
  )

  const grid = (
    <CartesianGrid
      strokeDasharray="3 3"
      stroke="var(--bsp-chart-grid, #e2e8f0)"
      vertical={false}
    />
  )

  const tooltip = <Tooltip content={(p) => <ChartTooltip {...p} hours={hours} />} />

  const refAreas = badRanges.map((r, i) => (
    <ReferenceArea
      key={i}
      x1={r.start}
      x2={r.end}
      fill={r.type === 'down' ? 'rgba(186,26,26,0.12)' : 'rgba(234,179,8,0.12)'}
      stroke="none"
    />
  ))

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{
          width: '100%', height: '100%',
          background: 'var(--bsp-chart-bg)',
          borderRadius: 8,
          animation: 'pulse 1.5s ease-in-out infinite',
        }} />
      </div>
    )
  }

  if (!data || data.every((b) => b.count === 0)) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--m3-secondary)', fontSize: 13 }}>No data for this period</p>
      </div>
    )
  }

  return (
    <div className="bsp-chart" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {title && (
        <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--m3-secondary)', marginBottom: 4, paddingLeft: 48, flexShrink: 0 }}>
          {title}
        </p>
      )}
      <ResponsiveContainer width="100%" height="99%">
        {showArea ? (
          <AreaChart {...commonProps}>
            <defs>
              <linearGradient id={`cg-${monitorId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={chartColor} stopOpacity={0.22} />
                <stop offset="95%" stopColor={chartColor} stopOpacity={0} />
              </linearGradient>
            </defs>
            {grid}
            {xAxis}
            {yAxis}
            {tooltip}
            {refAreas}
            <Area
              type="monotone"
              dataKey={aggKey}
              stroke={chartColor}
              strokeWidth={2}
              fill={`url(#cg-${monitorId})`}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
              connectNulls={false}
            />
          </AreaChart>
        ) : (
          <LineChart {...commonProps}>
            {grid}
            {xAxis}
            {yAxis}
            {tooltip}
            {refAreas}
            <Line
              type="monotone"
              dataKey={aggKey}
              stroke={chartColor}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
              connectNulls={false}
            />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}
