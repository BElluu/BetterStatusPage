import clsx from 'clsx'
import type { CSSProperties, ReactNode } from 'react'

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

type EmptyStateVariant = 'card' | 'inset' | 'row'

interface EmptyStateProps {
  title: ReactNode
  description?: ReactNode | undefined
  /** Material Symbols icon name, e.g. "radio_button_checked". */
  icon?: string | undefined
  /**
   * Optional follow-up action. Leave it out when the page header already offers the same action and
   * put an `EmptyStateLink` in the description instead.
   */
  action?: ReactNode | undefined
  /**
   * - `card` (default): a standalone compact strip, for pages without a table or list container.
   * - `inset`: a row inside a card or list, separated from what is above it by a divider.
   * - `row`: bare content for a table cell; use `EmptyTableRow` rather than this directly.
   */
  variant?: EmptyStateVariant | undefined
  className?: string | undefined
}

const EMPTY_VARIANT_CLASS: Record<EmptyStateVariant, string> = {
  card: 'rounded-2xl px-5 py-4',
  inset: 'px-6 py-5',
  row: '',
}

const EMPTY_VARIANT_STYLE: Record<EmptyStateVariant, CSSProperties | undefined> = {
  card: { background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' },
  inset: { borderTop: '1px solid var(--m3-outline-variant)' },
  row: undefined,
}

/** Compact placeholder for an empty list: an icon, a short explanation and an optional action in one row. */
export function EmptyState({ title, description, icon = 'inbox', action, variant = 'card', className }: EmptyStateProps) {
  return (
    <div
      className={clsx('flex flex-wrap items-center gap-x-3.5 gap-y-3 text-left', EMPTY_VARIANT_CLASS[variant], className)}
      style={EMPTY_VARIANT_STYLE[variant]}
    >
      <span
        className="grid place-items-center w-10 h-10 rounded-xl flex-none"
        aria-hidden="true"
        style={{ background: 'var(--admin-icon-container)', color: 'var(--admin-icon-color)' }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>{icon}</span>
      </span>
      <div className="min-w-0 flex-[1_1_15rem] space-y-0.5">
        <p className="font-headline font-semibold text-sm" style={{ color: 'var(--m3-on-surface)' }}>{title}</p>
        {description && <p className="text-[13px]" style={{ color: 'var(--m3-secondary)' }}>{description}</p>}
      </div>
      {action && <div className="flex-none sm:ml-auto">{action}</div>}
    </div>
  )
}

interface EmptyTableRowProps extends Omit<EmptyStateProps, 'variant' | 'className'> {
  /** Number of columns in the table, so the message spans the whole row. */
  colSpan: number
}

/** The only `<tbody>` row while a table has no data, so the table and its headers keep their place. */
export function EmptyTableRow({ colSpan, ...props }: EmptyTableRowProps) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-7">
        <EmptyState variant="row" {...props} />
      </td>
    </tr>
  )
}

interface EmptyStateLinkProps {
  onClick: () => void
  children: ReactNode
}

/** Inline text action inside an empty-state description, e.g. "Alerts stay silent until you [add a channel]." */
export function EmptyStateLink({ onClick, children }: EmptyStateLinkProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="font-semibold underline underline-offset-[3px] rounded focus-ring"
      style={{ color: 'var(--m3-on-surface)' }}
    >
      {children}
    </button>
  )
}
