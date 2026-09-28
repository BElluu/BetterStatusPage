import clsx from 'clsx'
import { useId, type ReactNode } from 'react'

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Visible label; clicking it toggles the switch. Without it pass `aria-label`. */
  label?: ReactNode | undefined
  description?: ReactNode | undefined
  disabled?: boolean | undefined
  id?: string | undefined
  'aria-label'?: string | undefined
  className?: string | undefined
}

/** On/off toggle rendered as <button role="switch">, optionally with a clickable label and a description. */
export function Switch({ checked, onChange, label, description, disabled = false, id, 'aria-label': ariaLabel, className }: SwitchProps) {
  const generatedId = useId()
  const switchId = id ?? generatedId
  const labelId = `${switchId}-label`
  const descriptionId = `${switchId}-description`

  const control = (
    <button
      id={switchId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      aria-labelledby={label ? labelId : undefined}
      aria-describedby={description ? descriptionId : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative flex-shrink-0 w-12 h-7 rounded-full transition-colors focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
      style={{ background: checked ? 'var(--m3-primary)' : 'var(--m3-outline-variant)' }}
    >
      <span
        aria-hidden="true"
        className="absolute top-1 w-5 h-5 rounded-full transition-all"
        style={{ left: checked ? '24px' : '4px', background: checked ? 'var(--m3-on-primary)' : 'var(--m3-outline)' }}
      />
    </button>
  )

  if (!label && !description) return <span className={clsx('inline-flex', className)}>{control}</span>

  return (
    <div className={clsx('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        {label && (
          <label
            id={labelId}
            htmlFor={switchId}
            className={clsx('block text-sm font-medium', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}
            style={{ color: 'var(--m3-on-surface)' }}
          >
            {label}
          </label>
        )}
        {description && <p id={descriptionId} className="text-xs mt-0.5" style={{ color: 'var(--m3-secondary)' }}>{description}</p>}
      </div>
      {control}
    </div>
  )
}
