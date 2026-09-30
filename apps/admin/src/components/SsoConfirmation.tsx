import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentUser, type ApiError } from '../api/client'
import { Alert } from './ui'

/** The confirmation popup reports on this channel. Some providers cut `window.opener`, so no postMessage. */
export const SSO_CONFIRM_CHANNEL = 'bsp-sso-confirm'
const SSO_CONFIRM_URL = '/api/v1/auth/oidc/confirm'
// The server-side flow expires after 10 minutes, so a popup left open longer cannot succeed.
const SSO_CONFIRM_TIMEOUT_MS = 10 * 60 * 1000

type ConfirmOutcome = 'ok' | 'failed' | 'blocked' | 'cancelled'

const OUTCOME_MESSAGES: Record<Exclude<ConfirmOutcome, 'ok'>, string> = {
  failed: 'The single sign-on confirmation did not succeed. Try again.',
  blocked: 'The browser blocked the sign-in window. Allow pop-ups for this site and try again.',
  cancelled: 'The single sign-on confirmation was cancelled.',
}

/** True when the session signed in with SSO, so sensitive actions are confirmed there instead of with a password. */
export function isSsoSession(): boolean {
  return getCurrentUser()?.authMethod === 'oidc'
}

/** True when the API refused an action until the SSO session is confirmed at the identity provider. */
export function isSsoConfirmationRequired(error: unknown): boolean {
  return (error as Partial<ApiError> | null)?.code === 'SSO_CONFIRMATION_REQUIRED'
}

function openSsoConfirmation(): { result: Promise<ConfirmOutcome>; cancel: () => void } {
  const popup = window.open(SSO_CONFIRM_URL, 'bsp-sso-confirm', 'popup,width=520,height=720')
  if (!popup) return { result: Promise.resolve('blocked'), cancel: () => {} }
  let finish: (outcome: ConfirmOutcome) => void = () => {}
  const result = new Promise<ConfirmOutcome>((resolve) => {
    const channel = new BroadcastChannel(SSO_CONFIRM_CHANNEL)
    const timer = setTimeout(() => finish('failed'), SSO_CONFIRM_TIMEOUT_MS)
    finish = (outcome) => {
      channel.close()
      clearTimeout(timer)
      resolve(outcome)
    }
    channel.onmessage = (event: MessageEvent<{ ok?: boolean }>) => finish(event.data?.ok === true ? 'ok' : 'failed')
  })
  return {
    result,
    cancel: () => {
      finish('cancelled')
      try { popup.close() } catch { /* already closed or no longer ours */ }
    },
  }
}

/**
 * Runs sensitive API calls of an SSO session. When the API asks for a confirmation, `run` opens the identity
 * provider in a popup right away and repeats the call once it succeeds; otherwise it throws with the reason.
 * The popup follows the user's click within one API round trip, which browsers still count as user-initiated.
 */
export function useSsoConfirmation() {
  const [waiting, setWaiting] = useState(false)
  const cancelRef = useRef<(() => void) | null>(null)
  useEffect(() => () => cancelRef.current?.(), [])

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action()
    } catch (error) {
      if (!isSsoConfirmationRequired(error)) throw error
      const { result, cancel } = openSsoConfirmation()
      cancelRef.current = cancel
      setWaiting(true)
      const outcome = await result
      cancelRef.current = null
      setWaiting(false)
      if (outcome !== 'ok') throw new Error(OUTCOME_MESSAGES[outcome], { cause: error })
      return action()
    }
  }, [])

  const cancel = useCallback(() => cancelRef.current?.(), [])
  return { run, waiting, cancel }
}

export type SsoConfirmationState = ReturnType<typeof useSsoConfirmation>

/** Takes the place of a "current password" field in an SSO session: a note, or the popup's progress. */
export function SsoConfirmationNote({ confirmation }: { confirmation: Pick<SsoConfirmationState, 'waiting' | 'cancel'> }) {
  if (!confirmation.waiting) {
    return <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>You signed in with single sign-on, so no password is needed. You may be asked to sign in again in a pop-up window.</p>
  }
  return (
    <Alert tone="info" title="Confirm it's you">
      <p>Sign in again with your identity provider in the pop-up window. This continues once you are done.</p>
      <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={confirmation.cancel}>Cancel</button>
    </Alert>
  )
}
