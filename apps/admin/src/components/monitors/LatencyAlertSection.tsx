import { useEffect, useState } from 'react'
import { DEFAULT_LATENCY_ALERT, LATENCY_FACTOR_RANGE, LATENCY_MIN_DELTA_MS_RANGE, LATENCY_SUSTAIN_RANGE, LATENCY_WINDOW_MINUTES_RANGE } from '@bsp/shared'
import { Field, Note } from '@better-forge/ui'

export interface LatencyAlertValues {
  latencyAlertFactor: number | null
  latencyAlertWindowMinutes: number
  latencyAlertMinDeltaMs: number
  latencyAlertSustain: number
}

interface Props {
  values: LatencyAlertValues
  onChange: (patch: Partial<LatencyAlertValues>) => void
  /** The usual p95 as last measured for this monitor; null until the alert has run once. */
  baselineMs: number | null
}

/**
 * A number typed freely and applied when the field is left: a controlled number input that clamps on every keystroke
 * cannot be typed into ("2." becomes "2" before the digit after the point arrives).
 */
function NumberField({ label, value, range, step, onCommit }: {
  label: string
  value: number
  range: readonly [number, number]
  step: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])

  function commit() {
    const typed = Number(draft)
    const next = draft.trim() === '' || !Number.isFinite(typed) ? value : Math.min(range[1], Math.max(range[0], typed))
    // Whole numbers for the fields that are counts or milliseconds, one decimal for the factor.
    const rounded = step < 1 ? Math.round(next * 10) / 10 : Math.round(next)
    setDraft(String(rounded))
    onCommit(rounded)
  }

  return (
    <Field label={label}>
      <input
        type="number" inputMode="decimal" className="input-sig" min={range[0]} max={range[1]} step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
      />
    </Field>
  )
}

/** Side panel: alerts when the monitor still answers but has become much slower than its own usual. */
export function LatencyAlertSection({ values, onChange, baselineMs }: Props) {
  const { latencyAlertFactor, latencyAlertWindowMinutes, latencyAlertMinDeltaMs, latencyAlertSustain } = values
  const enabled = latencyAlertFactor !== null
  const limitMs = enabled && baselineMs !== null ? Math.max(Math.round(baselineMs * latencyAlertFactor), baselineMs + latencyAlertMinDeltaMs) : null

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--m3-on-surface)' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange({ latencyAlertFactor: e.target.checked ? DEFAULT_LATENCY_ALERT.factor : null })}
        />
        Alert when responses get slower than usual
      </label>
      {enabled && (
        <div className="space-y-3">
          {/* items-end: a label that wraps to two lines pushes its field down, not out of line with its neighbour. */}
          <div className="grid grid-cols-2 items-end gap-3">
            <NumberField label="Slower by (×)" value={latencyAlertFactor} range={LATENCY_FACTOR_RANGE} step={0.1} onCommit={(v) => onChange({ latencyAlertFactor: v })} />
            <NumberField label="Measured over (minutes)" value={latencyAlertWindowMinutes} range={LATENCY_WINDOW_MINUTES_RANGE} step={1} onCommit={(v) => onChange({ latencyAlertWindowMinutes: v })} />
            <NumberField label="At least slower by (ms)" value={latencyAlertMinDeltaMs} range={LATENCY_MIN_DELTA_MS_RANGE} step={1} onCommit={(v) => onChange({ latencyAlertMinDeltaMs: v })} />
            <NumberField label="Confirm after (checks)" value={latencyAlertSustain} range={LATENCY_SUSTAIN_RANGE} step={1} onCommit={(v) => onChange({ latencyAlertSustain: v })} />
          </div>
          <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>
            {baselineMs !== null && limitMs !== null
              ? <>Usual p95: <b style={{ color: 'var(--m3-on-surface)' }}>{baselineMs} ms</b>. Alerts at <b style={{ color: 'var(--m3-on-surface)' }}>{limitMs} ms</b> or more.</>
              : 'The usual p95 is measured once the monitor has a day of results.'}
          </p>
        </div>
      )}
      <Note tone="info">
        Compares the 95th percentile of the last checks that answered with this monitor&apos;s own previous 7 days.
        A monitor that stops answering is handled by &quot;Alert after&quot;, and its status does not change here.
        Changing these settings, the check interval or the type closes an alert that is open, without a notification.
      </Note>
    </div>
  )
}
