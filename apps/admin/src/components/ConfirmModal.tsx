import { createPortal } from 'react-dom'

interface ConfirmModalProps {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Delete',
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      onClick={onCancel}
    >
      <div
        className="rounded-2xl p-6 w-full max-w-sm mx-4 space-y-4"
        style={{ background: 'var(--m3-surface-container-lowest)', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-headline text-lg font-bold" style={{ color: 'var(--m3-on-surface)' }}>
          {title}
        </h3>
        <p className="text-sm" style={{ color: 'var(--m3-on-surface-variant)' }}>
          {message}
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
            className="px-5 py-2 rounded-full text-sm font-bold transition-colors"
            style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-5 py-2 rounded-full text-sm font-bold transition-colors"
            style={{
              background: danger ? 'var(--m3-error)' : 'var(--m3-primary)',
              color: danger ? 'var(--m3-on-error)' : 'var(--m3-on-primary)',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
