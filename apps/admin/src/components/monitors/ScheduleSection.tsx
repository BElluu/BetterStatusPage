import { useId, useState } from 'react'
import { Field } from './monitorFormParts'

export interface ScheduleValues {
  intervalSecs: number
  timeoutMs: number
  retries: number
  failureThreshold: number
  recoveryThreshold: number
}

interface Props {
  values: ScheduleValues
  onChange: (patch: Partial<ScheduleValues>) => void
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

/** Check timing and alert thresholds, collapsed to a one-line summary; fields stay mounted so they keep their values. */
export function ScheduleSection({ values, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const { intervalSecs, timeoutMs, retries, failureThreshold, recoveryThreshold } = values
  const summary = [
    `Every ${intervalSecs} s`,
    `Timeout ${timeoutMs / 1000} s`,
    plural(retries, 'attempt', 'attempts'),
    `Alert after ${failureThreshold}`,
    `Recover after ${recoveryThreshold}`,
  ]

  return (
    <div className="rounded-xl overflow-hidden" style={{ background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)' }}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 text-left p-3 hover:bg-[var(--m3-surface-container)] focus-ring"
        style={{ color: 'var(--m3-on-surface)' }}
      >
        <span className="flex-none w-8 h-8 rounded-lg grid place-items-center" style={{ background: 'var(--admin-icon-container)', color: 'var(--admin-icon-color)' }}>
          <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 20 }}>schedule</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">Schedule &amp; alerting</span>
          <span className="flex flex-wrap gap-1.5 mt-1.5">
            {summary.map((s) => (
              <span key={s} className="font-mono text-[11px] rounded-md px-1.5 py-0.5 whitespace-nowrap" style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)' }}>{s}</span>
            ))}
          </span>
        </span>
        <span className="material-symbols-outlined transition-transform" aria-hidden="true" style={{ color: 'var(--m3-secondary)', transform: open ? 'rotate(180deg)' : undefined }}>expand_more</span>
      </button>

      <div id={bodyId} hidden={!open} className="p-3 pt-4 space-y-4" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Interval (s)">
            <input type="number" value={intervalSecs} onChange={(e) => onChange({ intervalSecs: Number(e.target.value) })} min={10} max={86400} className="input-sig" />
          </Field>
          <Field label="Timeout (ms)">
            <input type="number" value={timeoutMs} onChange={(e) => onChange({ timeoutMs: Number(e.target.value) })} min={1000} max={300000} className="input-sig" />
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Attempts">
            <input type="number" value={retries} onChange={(e) => onChange({ retries: Math.max(1, Number(e.target.value)) })} min={1} max={10} className="input-sig" />
          </Field>
          <span className="hidden sm:block" />
          <Field label="Alert after (checks)">
            <input type="number" value={failureThreshold} onChange={(e) => onChange({ failureThreshold: Math.max(1, Number(e.target.value)) })} min={1} max={20} className="input-sig" />
          </Field>
          <Field label="Recover after (checks)">
            <input type="number" value={recoveryThreshold} onChange={(e) => onChange({ recoveryThreshold: Math.max(1, Number(e.target.value)) })} min={1} max={20} className="input-sig" />
          </Field>
        </div>
        <p className="text-xs -mt-1" style={{ color: 'var(--m3-secondary)' }}>
          Consecutive checks required before a notification is sent. Raise the first value to stop a flapping
          endpoint from paging on every blip — the status page still updates immediately. 1 = notify on every change.
        </p>
      </div>
    </div>
  )
}
