import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { SSO_CONFIRM_CHANNEL, SsoConfirmationNote, isSsoConfirmationRequired, useSsoConfirmation } from './SsoConfirmation'

const confirmationRequired = () => new ApiError('Confirm your identity', 403, 'SSO_CONFIRMATION_REQUIRED')

function reportFromPopup(ok: boolean) {
  const channel = new BroadcastChannel(SSO_CONFIRM_CHANNEL)
  channel.postMessage({ ok })
  channel.close()
}

/** A form whose Save runs `action` through the confirmation, like the real forms do. */
function Harness({ action }: { action: () => Promise<string> }) {
  const confirmation = useSsoConfirmation()
  const [outcome, setOutcome] = useState('')
  return (
    <>
      <SsoConfirmationNote confirmation={confirmation} />
      <button type="button" onClick={() => void confirmation.run(action).then((value) => setOutcome(`saved ${value}`), (error: Error) => setOutcome(error.message))}>Save</button>
      <p>{outcome}</p>
    </>
  )
}

describe('useSsoConfirmation', () => {
  afterEach(() => vi.restoreAllMocks())

  it('recognises the API asking for an SSO confirmation', () => {
    expect(isSsoConfirmationRequired(confirmationRequired())).toBe(true)
    expect(isSsoConfirmationRequired(new ApiError('Nope', 400))).toBe(false)
    expect(isSsoConfirmationRequired(null)).toBe(false)
  })

  it('saves without a popup while the SSO sign-in is recent', async () => {
    const user = userEvent.setup()
    const open = vi.spyOn(window, 'open')
    render(<Harness action={vi.fn().mockResolvedValue('ok')} />)

    expect(screen.getByText(/no password is needed/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('saved ok')).toBeInTheDocument()
    expect(open).not.toHaveBeenCalled()
  })

  it('opens the popup from Save and repeats the call once confirmed', async () => {
    const user = userEvent.setup()
    const open = vi.spyOn(window, 'open').mockReturnValue({ close: vi.fn() } as unknown as Window)
    const action = vi.fn().mockRejectedValueOnce(confirmationRequired()).mockResolvedValueOnce('after confirmation')
    render(<Harness action={action} />)

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('/api/v1/auth/oidc/confirm', 'bsp-sso-confirm', expect.stringContaining('popup')))
    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeInTheDocument()

    reportFromPopup(true)
    expect(await screen.findByText('saved after confirmation')).toBeInTheDocument()
    expect(action).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })

  it('reports a failed, cancelled or blocked confirmation without repeating the call', async () => {
    const user = userEvent.setup()
    const open = vi.spyOn(window, 'open').mockReturnValue({ close: vi.fn() } as unknown as Window)
    const action = vi.fn().mockRejectedValue(confirmationRequired())
    render(<Harness action={action} />)

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('button', { name: 'Cancel' })
    reportFromPopup(false)
    expect(await screen.findByText(/did not succeed/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText(/was cancelled/)).toBeInTheDocument()

    open.mockReturnValue(null)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/blocked the sign-in window/)).toBeInTheDocument()
    expect(action).toHaveBeenCalledTimes(3)
  })
})
