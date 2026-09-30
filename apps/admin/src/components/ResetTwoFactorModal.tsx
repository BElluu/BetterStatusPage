import { useId, useState } from 'react'
import { ModalShell } from './ModalShell'
import { SsoConfirmationNote, isSsoSession, type SsoConfirmationState } from './SsoConfirmation'
import { Alert } from './ui'

const IDLE_CONFIRMATION = { waiting: false, cancel: () => {} }

interface ResetTwoFactorModalProps {
  email: string
  pending: boolean
  error?: string
  /** Progress of the SSO confirmation popup, which `onConfirm` opens when the API asks for it. */
  ssoConfirmation?: Pick<SsoConfirmationState, 'waiting' | 'cancel'>
  /** `currentPassword` is undefined in an SSO session, which is confirmed at the identity provider instead. */
  onConfirm: (currentPassword: string | undefined) => void
  onCancel: () => void
}

export function ResetTwoFactorModal({ email, pending, error, ssoConfirmation = IDLE_CONFIRMATION, onConfirm, onCancel }: ResetTwoFactorModalProps) {
  const sso = isSsoSession()
  const [currentPassword, setCurrentPassword] = useState('')
  const [typedEmail, setTypedEmail] = useState('')
  const titleId = useId()
  const canConfirm = !pending && (sso || currentPassword.length > 0) && typedEmail === email
  const confirm = () => onConfirm(sso ? undefined : currentPassword)

  return (
    <ModalShell onClose={pending ? undefined : onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={pending || undefined}
        className="rounded-2xl p-6 w-full max-w-md space-y-4"
        style={{ background: 'var(--m3-surface-container-lowest)', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
      >
        <div>
          <h3 id={titleId} className="font-headline text-lg font-bold" style={{ color: 'var(--m3-on-surface)' }}>Reset two-factor authentication</h3>
          <p className="text-sm mt-2" style={{ color: 'var(--m3-on-surface-variant)' }}>
            This removes 2FA from <strong>{email}</strong> and signs out all of their active sessions. Their password will not change.
          </p>
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        {sso ? <SsoConfirmationNote confirmation={ssoConfirmation} /> : <label className="block space-y-2 text-sm" style={{ color: 'var(--m3-on-surface-variant)' }}>
          <span>Your current password</span>
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            className="input-sig w-full"
          />
        </label>}

        <label className="block space-y-2 text-sm" style={{ color: 'var(--m3-on-surface-variant)' }}>
          <span>Type <strong className="font-mono">{email}</strong> to confirm</span>
          <input value={typedEmail} onChange={(event) => setTypedEmail(event.target.value)} autoFocus={sso} autoComplete="off" spellCheck={false} className="input-sig w-full" />
        </label>

        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel} disabled={pending} className="btn btn-secondary rounded-full px-5 py-2">Cancel</button>
          <button type="button" onClick={confirm} disabled={!canConfirm} className="btn btn-danger-outline rounded-full px-5 py-2">
            {pending ? 'Resetting…' : 'Reset 2FA'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
