import { useId, useState } from 'react'
import { ModalShell } from './ModalShell'

interface ConfirmModalProps {
  title: string
  message: string
  confirmLabel?: string | undefined
  danger?: boolean | undefined
  confirmationText?: string | undefined
  /**
   * While true the modal stays open with both buttons disabled and the confirm button reading
   * `pendingLabel`, so callers can keep it up until their mutation settles and close it in onSuccess.
   */
  pending?: boolean | undefined
  pendingLabel?: string | undefined
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Delete',
  danger = true,
  confirmationText,
  pending = false,
  pendingLabel = 'Working…',
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const [typedConfirmation, setTypedConfirmation] = useState('')
  const titleId = useId()
  const messageId = useId()
  const canConfirm = (!confirmationText || typedConfirmation === confirmationText) && !pending

  return (
    <ModalShell onClose={pending ? undefined : onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        aria-busy={pending || undefined}
        className="rounded-2xl p-6 w-full max-w-sm space-y-4"
        style={{ background: 'var(--m3-surface-container-lowest)', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
      >
        <h3 id={titleId} className="font-headline text-lg font-bold" style={{ color: 'var(--m3-on-surface)' }}>
          {title}
        </h3>
        <p id={messageId} className="text-sm" style={{ color: 'var(--m3-on-surface-variant)' }}>
          {message}
        </p>
        {confirmationText && (
          <label className="block space-y-2 text-sm" style={{ color: 'var(--m3-on-surface-variant)' }}>
            <span>Type <strong className="font-mono">{confirmationText}</strong> to confirm:</span>
            <input
              autoFocus
              value={typedConfirmation}
              disabled={pending}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTypedConfirmation(event.target.value)}
              className="input-m3"
            />
          </label>
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel} disabled={pending} className="btn btn-secondary rounded-full px-5 py-2">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'} rounded-full px-5 py-2`}
          >
            {pending ? pendingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
