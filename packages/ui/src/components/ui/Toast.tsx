import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MODAL_Z_INDEX } from '../ModalShell'

export type ToastTone = 'success' | 'error' | 'info'

export interface ToastOptions {
  /** Milliseconds before it disappears on its own; 0 keeps it until dismissed. Default 4000. */
  duration?: number | undefined
}

export interface ToastApi {
  success: (message: ReactNode, options?: ToastOptions) => number
  error: (message: ReactNode, options?: ToastOptions) => number
  info: (message: ReactNode, options?: ToastOptions) => number
  dismiss: (id: number) => void
}

interface ToastEntry { id: number; tone: ToastTone; message: ReactNode; duration: number }

export const TOAST_DURATION = 4000

const noop: ToastApi = { success: () => 0, error: () => 0, info: () => 0, dismiss: () => {} }

// Outside a provider (isolated component tests) toasts are silently dropped instead of throwing.
const ToastContext = createContext<ToastApi>(noop)

/** `const toast = useToast(); toast.success('Saved')`. The returned object is stable across renders. */
export function useToast(): ToastApi {
  return useContext(ToastContext)
}

const TONE_STYLE: Record<ToastTone, { icon: string; color: string }> = {
  success: { icon: 'check_circle', color: 'var(--m3-up)' },
  error:   { icon: 'error',        color: 'var(--m3-down)' },
  info:    { icon: 'info',         color: 'var(--m3-on-surface-variant)' },
}

function ToastItem({ toast, onDismiss }: { toast: ToastEntry; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false)
  const { icon, color } = TONE_STYLE[toast.tone]

  useEffect(() => {
    if (paused || toast.duration <= 0) return
    const timer = setTimeout(() => onDismiss(toast.id), toast.duration)
    return () => clearTimeout(timer)
  }, [paused, toast.duration, toast.id, onDismiss])

  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      data-tone={toast.tone}
      className="admin-toast pointer-events-auto flex items-start gap-3 rounded-xl px-4 py-3 text-sm w-full"
      style={{ background: 'var(--m3-surface-container-lowest)', color: 'var(--m3-on-surface)', border: '1px solid var(--m3-outline-variant)', borderLeft: `4px solid ${color}`, boxShadow: '0 8px 24px rgba(0,0,0,0.14)' }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="material-symbols-outlined flex-shrink-0 mt-px" aria-hidden="true" style={{ fontSize: '18px', color }}>{icon}</span>
      <div className="flex-1 min-w-0 break-words">{toast.message}</div>
      <button type="button" onClick={() => onDismiss(toast.id)} aria-label="Dismiss" className="btn-icon -my-1 -mr-2 w-7 h-7">
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px' }}>close</span>
      </button>
    </div>
  )
}

/** Mount once near the root; renders the bottom-right toast stack above every modal. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const api = useMemo<ToastApi>(() => {
    const push = (tone: ToastTone) => (message: ReactNode, options?: ToastOptions) => {
      const id = nextId.current++
      setToasts((current) => [...current.slice(-4), { id, tone, message, duration: options?.duration ?? TOAST_DURATION }])
      return id
    }
    return { success: push('success'), error: push('error'), info: push('info'), dismiss }
  }, [dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div
          role="region"
          aria-live="polite"
          aria-label="Notifications"
          className="fixed bottom-4 right-4 left-4 sm:left-auto sm:w-96 flex flex-col items-end gap-2 pointer-events-none"
          style={{ zIndex: MODAL_Z_INDEX + 1 }}
        >
          {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />)}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}
