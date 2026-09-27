import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const MODAL_Z_INDEX = 9999
export const MODAL_BACKDROP = 'rgba(0,0,0,0.55)'

interface ModalShellProps {
  children: ReactNode
  /** `top` for tall forms that scroll with the page; `center` for short dialogs. */
  align?: 'center' | 'top'
}

/**
 * The single backdrop every admin modal renders through, so stacking, dimming and dismissal stay consistent:
 * portalled to <body>, z-index 9999, a 55% black scrollable overlay, and a backdrop click never dismisses —
 * a stray click must not throw away a half-filled form. Dialogs close from their own Cancel / × controls.
 */
export function ModalShell({ children, align = 'center' }: ModalShellProps) {
  return createPortal(
    <div data-testid="modal-backdrop" style={{ position: 'fixed', inset: 0, zIndex: MODAL_Z_INDEX, background: MODAL_BACKDROP, overflowY: 'auto' }}>
      <div style={{ display: 'flex', minHeight: '100%', alignItems: align === 'top' ? 'flex-start' : 'center', justifyContent: 'center', padding: '16px' }}>
        {children}
      </div>
    </div>,
    document.body,
  )
}

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
}

/** A titled panel with a close button inside the shared shell, for simple forms. */
export function Modal({ title, onClose, children }: ModalProps) {
  return (
    <ModalShell>
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-2xl" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
          <h3 className="font-headline font-bold text-lg" style={{ color: 'var(--m3-on-surface)' }}>{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="w-8 h-8 flex items-center justify-center rounded-lg text-xl leading-none" style={{ color: 'var(--m3-secondary)' }}>×</button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </ModalShell>
  )
}
