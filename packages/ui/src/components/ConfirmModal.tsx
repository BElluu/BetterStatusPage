import { useId, useState } from 'react'
import { ModalFooter, ModalHeader, ModalShell } from './ModalShell'

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
        className="rounded-2xl w-full max-w-sm"
        style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}
      >
        <ModalHeader icon={danger ? 'warning' : 'help'} titleId={titleId} title={title} onClose={pending ? () => {} : onCancel} />
        <div className="p-6 space-y-4">
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
        </div>
        <ModalFooter>
          <button type="button" onClick={onCancel} disabled={pending} className="btn btn-secondary">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          >
            {pending ? pendingLabel : confirmLabel}
          </button>
        </ModalFooter>
      </div>
    </ModalShell>
  )
}
