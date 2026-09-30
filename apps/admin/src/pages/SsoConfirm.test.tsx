import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SSO_CONFIRM_CHANNEL } from '../components/SsoConfirmation'
import SsoConfirmPage from './SsoConfirm'

const channels: { name: string; postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = []

class FakeBroadcastChannel {
  postMessage = vi.fn()
  close = vi.fn()
  constructor(public name: string) {
    channels.push(this)
  }
}

function renderPage(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <SsoConfirmPage />
    </MemoryRouter>,
  )
}

describe('SsoConfirmPage', () => {
  beforeEach(() => {
    channels.length = 0
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    vi.spyOn(window, 'close').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reports success to the opener and closes the popup', () => {
    renderPage('/admin/sso-confirm?status=ok')

    expect(screen.getByText('Confirmed. You can close this window.')).toBeInTheDocument()
    expect(channels).toHaveLength(1)
    expect(channels[0]!.name).toBe(SSO_CONFIRM_CHANNEL)
    expect(channels[0]!.postMessage).toHaveBeenCalledWith({ ok: true })
    expect(channels[0]!.close).toHaveBeenCalled()
    expect(window.close).toHaveBeenCalled()
  })

  it('reports failure and keeps the popup open', () => {
    renderPage('/admin/sso-confirm?status=error')

    expect(screen.getByText(/confirmation did not succeed/)).toBeInTheDocument()
    expect(channels[0]!.postMessage).toHaveBeenCalledWith({ ok: false })
    expect(channels[0]!.close).toHaveBeenCalled()
    expect(window.close).not.toHaveBeenCalled()
  })
})
