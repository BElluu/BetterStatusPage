import { HEADER_ASSERTION_OPS, JSON_ASSERTION_OPS, MAX_DEGRADED_ABOVE_MS, MAX_HTTP_ASSERTIONS } from '@bsp/shared'
import type { AssertionFailureStatus, HttpAssertion } from '@bsp/shared'
import { Field } from './monitorFormParts'

interface Props {
  keyword: string
  assertions: HttpAssertion[]
  degradedAboveMs: number | undefined
  onKeywordChange: (keyword: string) => void
  onAssertionsChange: (assertions: HttpAssertion[]) => void
  onDegradedAboveMsChange: (ms: number | undefined) => void
}

const OP_LABELS: Record<string, string> = {
  exists: 'exists',
  'not-exists': 'does not exist',
  equals: 'equals',
  'not-equals': 'does not equal',
  contains: 'contains',
  lt: 'is less than',
  gt: 'is greater than',
}

const needsValue = (op: string) => op !== 'exists' && op !== 'not-exists'

/** Response checks beyond the status code: a keyword in the body, headers, fields of a JSON body and a slow-response limit. */
export function HttpAssertionsFields({ keyword, assertions, degradedAboveMs, onKeywordChange, onAssertionsChange, onDegradedAboveMsChange }: Props) {
  const update = (index: number, next: HttpAssertion) => onAssertionsChange(assertions.map((a, i) => (i === index ? next : a)))
  const remove = (index: number) => onAssertionsChange(assertions.filter((_, i) => i !== index))
  const switchKind = (index: number, type: HttpAssertion['type']) =>
    update(index, type === 'header' ? { type, name: '', op: 'exists', onFail: 'degraded' } : { type, path: '$.', op: 'exists', onFail: 'degraded' })
  const switchOp = (index: number, a: HttpAssertion, op: string) => {
    const { value: _dropped, ...rest } = a
    update(index, (needsValue(op) && a.value !== undefined ? { ...rest, op, value: a.value } : { ...rest, op }) as HttpAssertion)
  }

  return (
    <div className="space-y-3">
      <Field label="Keyword (optional)">
        <input value={keyword} onChange={(e) => onKeywordChange(e.target.value)} className="input-sig" placeholder="body must contain… (otherwise Degraded)" />
      </Field>
      <Field label="Degraded when slower than (ms, optional)">
        <input type="number" min={1} max={MAX_DEGRADED_ABOVE_MS} value={degradedAboveMs ?? ''} className="input-sig" placeholder="e.g. 2000"
          onChange={(e) => onDegradedAboveMsChange(e.target.value === '' ? undefined : Number(e.target.value))} />
      </Field>

      <div className="space-y-2">
        <span className="text-xs font-medium" style={{ color: 'var(--m3-on-surface-variant)' }}>Response checks (optional)</span>
        {assertions.map((a, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select aria-label={`Check ${i + 1} target`} value={a.type} onChange={(e) => switchKind(i, e.target.value as HttpAssertion['type'])} className="input-sig" style={{ width: '6.5rem' }}>
              <option value="header">Header</option>
              <option value="json">JSON</option>
            </select>
            {a.type === 'header'
              ? <input aria-label={`Check ${i + 1} header name`} value={a.name} onChange={(e) => update(i, { ...a, name: e.target.value })} className="input-sig" style={{ width: '9rem' }} placeholder="X-Replicas" />
              : <input aria-label={`Check ${i + 1} JSON path`} value={a.path} onChange={(e) => update(i, { ...a, path: e.target.value })} className="input-sig" style={{ width: '9rem' }} placeholder="$.queue.length" />}
            <select aria-label={`Check ${i + 1} condition`} value={a.op} onChange={(e) => switchOp(i, a, e.target.value)} className="input-sig" style={{ width: '9.5rem' }}>
              {(a.type === 'header' ? HEADER_ASSERTION_OPS : JSON_ASSERTION_OPS).map((op) => <option key={op} value={op}>{OP_LABELS[op]}</option>)}
            </select>
            {needsValue(a.op) && (
              <input aria-label={`Check ${i + 1} value`} value={a.value ?? ''} onChange={(e) => update(i, { ...a, value: e.target.value } as HttpAssertion)} className="input-sig" style={{ width: '7rem' }} placeholder="value" />
            )}
            <select aria-label={`Check ${i + 1} when it fails`} value={a.onFail ?? 'degraded'} onChange={(e) => update(i, { ...a, onFail: e.target.value as AssertionFailureStatus })} className="input-sig" style={{ width: '11rem' }}>
              <option value="degraded">Fail → Degraded</option>
              <option value="down">Fail → Down</option>
            </select>
            <button type="button" onClick={() => remove(i)} aria-label={`Remove check ${i + 1}`} title="Remove check" className="btn-icon text-sm leading-none">×</button>
          </div>
        ))}
        {assertions.length < MAX_HTTP_ASSERTIONS && (
          <button type="button" className="text-xs font-medium" style={{ color: 'var(--m3-primary)' }}
            onClick={() => onAssertionsChange([...assertions, { type: 'header', name: '', op: 'exists', onFail: 'degraded' }])}>
            + Add check
          </button>
        )}
        {assertions.some((a) => a.type === 'json') && (
          <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>
            Checked on the final response, after redirects. JSON paths look like <code>$.queue.length</code> or <code>$.items[0].id</code>; a JSON body over 1 MB is not parsed.
          </p>
        )}
      </div>
    </div>
  )
}
