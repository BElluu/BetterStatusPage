import clsx from 'clsx'
import type { ReactNode } from 'react'

interface LoadingStateProps {
  label?: string | undefined
  className?: string | undefined
}

/** Centered spinner with a caption for data that is still loading. */
export function LoadingState({ label = 'Loading…', className }: LoadingStateProps) {
  return (
    <div role="status" aria-live="polite" className={clsx('flex items-center justify-center gap-3 py-12 text-sm', className)} style={{ color: 'var(--m3-secondary)' }}>
      <span className="material-symbols-outlined animate-spin" aria-hidden="true" style={{ fontSize: '20px' }}>progress_activity</span>
      <span>{label}</span>
    </div>
  )
}

interface ErrorStateProps {
  message?: ReactNode | undefined
  /** Renders a "Try again" button. Pass e.g. `() => void query.refetch()`. */
  onRetry?: (() => void) | undefined
  className?: string | undefined
}

/** Failed-to-load panel with an optional retry action. */
export function ErrorState({ message = 'Something went wrong while loading this data.', onRetry, className }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={clsx('flex flex-col items-center justify-center gap-3 rounded-2xl px-6 py-10 text-center', className)}
      style={{ background: 'var(--m3-down-bg)', color: 'var(--m3-down)' }}
    >
      <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '28px' }}>error</span>
      <p className="text-sm max-w-md">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn btn-secondary btn-sm">
          <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
          Try again
        </button>
      )}
    </div>
  )
}

interface EmptyStateProps {
  title: ReactNode
  description?: ReactNode | undefined
  /** Material Symbols icon name, e.g. "radio_button_checked". */
  icon?: string | undefined
  /** Primary call to action, typically `<button className="btn btn-primary">…</button>`. */
  action?: ReactNode | undefined
  className?: string | undefined
}

/** Placeholder for an empty list, with an icon, short explanation and a call to action. */
export function EmptyState({ title, description, icon = 'inbox', action, className }: EmptyStateProps) {
  return (
    <div
      className={clsx('flex flex-col items-center justify-center gap-3 rounded-2xl px-6 py-12 text-center', className)}
      style={{ background: 'var(--m3-surface-container-lowest)', border: '1px dashed var(--m3-outline-variant)' }}
    >
      <span
        className="material-symbols-outlined rounded-xl p-2.5"
        aria-hidden="true"
        style={{ fontSize: '24px', background: 'var(--admin-icon-container)', color: 'var(--admin-icon-color)' }}
      >
        {icon}
      </span>
      <div className="space-y-1">
        <p className="font-headline font-semibold text-base" style={{ color: 'var(--m3-on-surface)' }}>{title}</p>
        {description && <p className="text-sm max-w-md" style={{ color: 'var(--m3-secondary)' }}>{description}</p>}
      </div>
      {action && <div className="pt-1">{action}</div>}
    </div>
  )
}
