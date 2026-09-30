import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SSO_CONFIRM_CHANNEL } from '../components/SsoConfirmation'

/** Where the SSO confirmation popup lands: tells the window that opened it how it went, then closes. */
export default function SsoConfirmPage() {
  const [params] = useSearchParams()
  const ok = params.get('status') === 'ok'

  useEffect(() => {
    const channel = new BroadcastChannel(SSO_CONFIRM_CHANNEL)
    channel.postMessage({ ok })
    channel.close()
    if (ok) window.close()
  }, [ok])

  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: 'var(--m3-surface)', color: 'var(--m3-on-surface)' }}>
      <p className="text-sm text-center max-w-sm">
        {ok
          ? 'Confirmed. You can close this window.'
          : 'The confirmation did not succeed. Close this window and try again.'}
      </p>
    </div>
  )
}
