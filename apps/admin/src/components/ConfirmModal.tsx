import { createPortal } from 'react-dom'
import { useState } from 'react'

interface ConfirmModalProps {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  confirmationText?: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Delete',
  danger = true,
  confirmationText,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const [typedConfirmation, setTypedConfirmation] = useState('')
  const canConfirm = !confirmationText || typedConfirmation === confirmationText

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
        {confirmationText && (
          <label className="block space-y-2 text-sm" style={{ color: 'var(--m3-on-surface-variant)' }}>
            <span>Type <strong className="font-mono">{confirmationText}</strong> to confirm:</span>
            <input
              autoFocus
              value={typedConfirmation}
              onChange={(event) => setTypedConfirmation(event.target.value)}
              className="w-full rounded-xl px-3 py-2 outline-none"
              style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-on-surface)', border: '1px solid var(--m3-outline-variant)' }}
            />
          </label>
        )}
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
            disabled={!canConfirm}
            className="px-5 py-2 rounded-full text-sm font-bold transition-colors"
            style={{
              background: danger ? 'var(--m3-error)' : 'var(--m3-primary)',
              color: danger ? 'var(--m3-on-error)' : 'var(--m3-on-primary)',
              opacity: canConfirm ? 1 : 0.5,
              cursor: canConfirm ? 'pointer' : 'not-allowed',
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
