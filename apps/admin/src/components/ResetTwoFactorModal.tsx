import { useState } from 'react'
import { createPortal } from 'react-dom'

interface ResetTwoFactorModalProps {
  email: string
  pending: boolean
  error?: string
  onConfirm: (currentPassword: string) => void
  onCancel: () => void
}

export function ResetTwoFactorModal({ email, pending, error, onConfirm, onCancel }: ResetTwoFactorModalProps) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [typedEmail, setTypedEmail] = useState('')
  const canConfirm = !pending && currentPassword.length > 0 && typedEmail === email

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.4)' }} onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reset-2fa-title"
        className="rounded-2xl p-6 w-full max-w-md mx-4 space-y-4"
        style={{ background: 'var(--m3-surface-container-lowest)', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <h3 id="reset-2fa-title" className="font-headline text-lg font-bold" style={{ color: 'var(--m3-on-surface)' }}>Reset two-factor authentication</h3>
          <p className="text-sm mt-2" style={{ color: 'var(--m3-on-surface-variant)' }}>
            This removes 2FA from <strong>{email}</strong> and signs out all of their active sessions. Their password will not change.
          </p>
        </div>

        {error && <div className="rounded-xl px-4 py-3 text-sm" style={{ background: 'var(--m3-down-bg)', color: 'var(--m3-down)' }}>{error}</div>}

        <label className="block space-y-2 text-sm" style={{ color: 'var(--m3-on-surface-variant)' }}>
          <span>Your current password</span>
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            className="input-sig w-full"
          />
        </label>

        <label className="block space-y-2 text-sm" style={{ color: 'var(--m3-on-surface-variant)' }}>
          <span>Type <strong className="font-mono">{email}</strong> to confirm</span>
          <input value={typedEmail} onChange={(event) => setTypedEmail(event.target.value)} className="input-sig w-full" />
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel} disabled={pending} className="px-5 py-2 rounded-full text-sm font-bold transition-colors" style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)' }}>Cancel</button>
          <button type="button" onClick={() => onConfirm(currentPassword)} disabled={!canConfirm} className="btn-danger-outline px-5 py-2 rounded-full text-sm font-bold">
            {pending ? 'Resetting…' : 'Reset 2FA'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
