import clsx from 'clsx'
import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'

/** Props Field hands to its control so the label, hint and error are programmatically associated. */
export interface FieldControlProps {
  id: string
  'aria-describedby'?: string | undefined
  'aria-invalid'?: true | undefined
  'aria-required'?: true | undefined
}

interface FieldProps {
  label: ReactNode
  hint?: ReactNode | undefined
  error?: ReactNode | undefined
  required?: boolean | undefined
  /** Use a specific id for the control (otherwise one is generated, or the child's own `id` is kept). */
  id?: string | undefined
  /** `caps`: small mono uppercase label (form default); `plain`: small sentence-case label. */
  variant?: 'caps' | 'plain' | undefined
  className?: string | undefined
  /**
   * Either a single control element (input/select/textarea/custom component that forwards `id` and aria-*),
   * which receives the props via cloneElement, or a render function receiving them to spread where needed.
   */
  children: ReactElement<Partial<FieldControlProps>> | ((control: FieldControlProps) => ReactNode)
}

const LABEL_CLASS = {
  caps: 'block font-mono text-xs uppercase tracking-wider mb-2',
  plain: 'block text-xs mb-1.5',
}

export function Field({ label, hint, error, required = false, id, variant = 'caps', className, children }: FieldProps) {
  const generatedId = useId()
  const childId = typeof children !== 'function' && isValidElement(children) ? children.props.id : undefined
  const controlId = id ?? childId ?? generatedId
  const hintId = hint ? `${controlId}-hint` : undefined
  const errorId = error ? `${controlId}-error` : undefined
  const existingDescribedBy = typeof children !== 'function' && isValidElement(children) ? children.props['aria-describedby'] : undefined
  const describedBy = [existingDescribedBy, hintId, errorId].filter(Boolean).join(' ') || undefined

  const controlProps: FieldControlProps = {
    id: controlId,
    'aria-describedby': describedBy,
    ...(error ? { 'aria-invalid': true as const } : {}),
    ...(required ? { 'aria-required': true as const } : {}),
  }

  const control = typeof children === 'function' ? children(controlProps) : cloneElement(children, controlProps)

  return (
    <div className={className}>
      <label htmlFor={controlId} className={LABEL_CLASS[variant]} style={{ color: 'var(--m3-secondary)' }}>
        {label}
        {required && <span aria-hidden="true" style={{ color: 'var(--m3-down)' }}> *</span>}
      </label>
      {control}
      {hint && <p id={hintId} className="text-xs mt-1.5" style={{ color: 'var(--m3-secondary)' }}>{hint}</p>}
      {error && <p id={errorId} className={clsx('text-xs', hint ? 'mt-1' : 'mt-1.5')} style={{ color: 'var(--m3-down)' }}>{error}</p>}
    </div>
  )
}
