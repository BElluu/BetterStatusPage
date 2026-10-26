import { useId, useState } from 'react'
import { ModalFooter, ModalHeader, ModalShell } from './ModalShell'
import { SsoConfirmationNote, isSsoSession, useSsoConfirmation } from './SsoConfirmation'
import { Alert } from './ui'

interface ConfirmIdentityModalProps {
  title: string
  message: string
  confirmLabel: string
  pendingLabel?: string
  danger?: boolean
  /**
   * Runs the action. `currentPassword` is undefined in an SSO session, which is confirmed at the identity
   * provider instead. A rejection is shown in the dialog, which stays open for another try.
   */
  action: (currentPassword: string | undefined) => Promise<unknown>
  /** Called when the action succeeded or the user gave up. */
  onClose: () => void
}

/** Asks the signed-in user to prove it is them (password, or SSO) before a sensitive action goes through. */
export function ConfirmIdentityModal({ title, message, confirmLabel, pendingLabel = 'Working…', danger = false, action, onClose }: ConfirmIdentityModalProps) {
  const sso = isSsoSession()
  const ssoConfirmation = useSsoConfirmation()
  const [currentPassword, setCurrentPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const titleId = useId()
  const canConfirm = !pending && (sso || currentPassword.length > 0)

  async function confirm() {
    setPending(true)
    setError('')
    try {
      await ssoConfirmation.run(() => action(sso ? undefined : currentPassword))
      onClose()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Something went wrong. Try again.')
      setPending(false)
    }
  }

  return (
    <ModalShell onClose={pending ? undefined : onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={pending || undefined}
        className="rounded-2xl w-full max-w-md"
        style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}
        onSubmit={(event) => { event.preventDefault(); if (canConfirm) void confirm() }}
      >
        <ModalHeader icon="shield_lock" titleId={titleId} title={title} onClose={pending ? () => {} : onClose} />
        <div className="p-6 space-y-4">
          <p className="text-sm" style={{ color: 'var(--m3-on-surface-variant)' }}>{message}</p>
          {error && <Alert tone="error">{error}</Alert>}
          {sso ? <SsoConfirmationNote confirmation={ssoConfirmation} /> : (
            <label className="block space-y-2 text-sm" style={{ color: 'var(--m3-on-surface-variant)' }}>
              <span>Your current password</span>
              <input
                type="password"
                autoComplete="current-password"
                autoFocus
                value={currentPassword}
                disabled={pending}
                onChange={(event) => setCurrentPassword(event.target.value)}
                className="input-sig w-full"
              />
            </label>
          )}
        </div>
        <ModalFooter>
          <button type="button" onClick={onClose} disabled={pending} className="btn btn-secondary">Cancel</button>
          <button type="submit" disabled={!canConfirm} className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}>
            {pending ? pendingLabel : confirmLabel}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  )
}
