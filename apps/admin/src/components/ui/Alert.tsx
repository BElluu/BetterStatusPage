import clsx from 'clsx'
import type { CSSProperties, ReactNode } from 'react'

export type AlertTone = 'error' | 'success' | 'info' | 'warning'

const TONES: Record<AlertTone, { icon: string; style: CSSProperties }> = {
  error:   { icon: 'error',        style: { background: 'var(--m3-down-bg)', color: 'var(--m3-down)', borderColor: 'color-mix(in srgb, var(--m3-down) 30%, transparent)' } },
  success: { icon: 'check_circle', style: { background: 'var(--m3-up-bg)', color: 'var(--m3-up)', borderColor: 'color-mix(in srgb, var(--m3-up) 30%, transparent)' } },
  warning: { icon: 'warning',      style: { background: 'var(--m3-degraded-bg)', color: 'var(--m3-degraded)', borderColor: 'color-mix(in srgb, var(--m3-degraded) 30%, transparent)' } },
  info:    { icon: 'info',         style: { background: 'var(--m3-surface-container-high)', color: 'var(--m3-on-surface)', borderColor: 'var(--m3-outline-variant)' } },
}

interface AlertProps {
  tone: AlertTone
  children: ReactNode
  /** Optional bold first line. */
  title?: ReactNode | undefined
  /** Renders a × button (aria-label "Dismiss") that calls this. */
  onDismiss?: (() => void) | undefined
  className?: string | undefined
}

/** Inline, token-coloured message box. Errors are announced assertively (role="alert"); other tones politely. */
export function Alert({ tone, children, title, onDismiss, className }: AlertProps) {
  const { icon, style } = TONES[tone]
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      data-tone={tone}
      className={clsx('flex items-start gap-3 rounded-xl border px-4 py-3 text-sm', className)}
      style={style}
    >
      <span className="material-symbols-outlined flex-shrink-0 mt-px" aria-hidden="true" style={{ fontSize: '18px' }}>{icon}</span>
      <div className="flex-1 min-w-0 break-words">
        {title && <p className="font-semibold">{title}</p>}
        <div className={title ? 'mt-0.5' : undefined}>{children}</div>
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="btn-icon -my-1 -mr-2" style={{ color: 'inherit' }}>
          <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>close</span>
        </button>
      )}
    </div>
  )
}
