import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const MODAL_Z_INDEX = 9999
export const MODAL_BACKDROP = 'rgba(0,0,0,0.55)'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Open shells, innermost last: only the top one reacts to Escape and traps Tab. */
const openShells: HTMLElement[] = []

interface ModalShellProps {
  children: ReactNode
  /** `top` for tall forms that scroll with the page; `center` for short dialogs. */
  align?: 'center' | 'top' | undefined
  /** Called when Escape is pressed while this is the topmost modal. Omit to ignore Escape. */
  onClose?: (() => void) | undefined
  /**
   * Accessible name. When given (or `labelledBy`), the shell itself carries role="dialog" aria-modal —
   * use it when the child panel does not declare its own dialog role.
   */
  label?: string | undefined
  labelledBy?: string | undefined
}

/**
 * The single backdrop every admin modal renders through, so stacking, dimming and dismissal stay consistent:
 * portalled to <body>, z-index 9999, a 55% black scrollable overlay, and a backdrop click never dismisses —
 * a stray click must not throw away a half-filled form. Dialogs close from their own Cancel / × controls and,
 * when `onClose` is passed, from Escape. Focus moves into the modal on open (unless a child already took it
 * with autoFocus), Tab cycles inside it, and focus returns to the opener on close.
 */
export function ModalShell({ children, align = 'center', onClose, label, labelledBy }: ModalShellProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })
  // Read during the first render, before an autoFocus child steals focus, so closing returns it to the opener.
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null)

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    openShells.push(panel)
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true })

    const onKeyDown = (event: KeyboardEvent) => {
      if (openShells[openShells.length - 1] !== panel || event.defaultPrevented || event.isComposing) return
      if (event.key === 'Escape') {
        if (onCloseRef.current) {
          event.preventDefault()
          onCloseRef.current()
        }
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (focusable.length === 0) { event.preventDefault(); return }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === panel)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus() }
      else if (!panel.contains(active)) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const index = openShells.lastIndexOf(panel)
      if (index >= 0) openShells.splice(index, 1)
      if (opener && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [opener])

  const dialogProps = label || labelledBy
    ? { role: 'dialog', 'aria-modal': true, 'aria-label': label, 'aria-labelledby': labelledBy }
    : {}

  return createPortal(
    <div data-testid="modal-backdrop" style={{ position: 'fixed', inset: 0, zIndex: MODAL_Z_INDEX, background: MODAL_BACKDROP, overflowY: 'auto' }}>
      <div
        ref={panelRef}
        tabIndex={-1}
        {...dialogProps}
        style={{ display: 'flex', minHeight: '100%', alignItems: align === 'top' ? 'flex-start' : 'center', justifyContent: 'center', padding: '16px', outline: 'none' }}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

interface ModalHeaderProps {
  /** Material Symbols name shown before the title, so every dialog header reads the same way. */
  icon: string
  title: ReactNode
  /** Id for the heading, when the dialog is labelled by it via `labelledBy`. */
  titleId?: string | undefined
  onClose: () => void
}

/** The shared dialog header: icon, title and a × close button above a divider. */
export function ModalHeader({ icon, title, titleId, onClose }: ModalHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-3 px-6 py-5" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
      <div className="flex items-center gap-3 min-w-0">
        <span className="material-symbols-outlined shrink-0" aria-hidden="true" style={{ fontSize: '22px', color: 'var(--m3-primary)' }}>{icon}</span>
        <h3 id={titleId} className="font-headline font-bold text-lg break-words min-w-0" style={{ color: 'var(--m3-on-surface)' }}>{title}</h3>
      </div>
      <button type="button" onClick={onClose} aria-label="Close" className="btn-icon shrink-0">
        <span className="material-symbols-outlined" aria-hidden="true">close</span>
      </button>
    </div>
  )
}

interface ModalProps {
  title: string
  /** Material Symbols name for the header icon. */
  icon: string
  onClose: () => void
  children: ReactNode
}

/** A titled panel with a close button inside the shared shell, for simple forms. Escape closes it. */
export function Modal({ title, icon, onClose, children }: ModalProps) {
  return (
    <ModalShell onClose={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-2xl" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
        <ModalHeader icon={icon} title={title} onClose={onClose} />
        <div className="p-6">{children}</div>
      </div>
    </ModalShell>
  )
}
