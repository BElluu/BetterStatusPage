import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { postJSON } from '../api'
import { navigation } from '../navigation'
import { AccountMenu } from './AccountMenu'

vi.mock('../api', () => ({ postJSON: vi.fn() }))
vi.mock('../i18n/LocaleContext', () => ({
  useLocale: () => ({ t: (key: string, params?: Record<string, string>) => (params ? `${key} ${Object.values(params).join(' ')}` : key) }),
}))

describe('AccountMenu', () => {
  it('shows who is signed in, and closes on Escape and on a click elsewhere', async () => {
    const user = userEvent.setup()
    render(<AccountMenu email="viewer@example.test" role="viewer" />)

    await user.click(screen.getByRole('button', { name: 'signIn.account' }))
    expect(screen.getByText('signIn.signedInAs viewer@example.test')).toBeInTheDocument()
    // A viewer has nothing to do in the admin console.
    expect(screen.queryByRole('link', { name: /signIn.adminConsole/ })).not.toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByText('signIn.signedInAs viewer@example.test')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'signIn.account' }))
    await user.click(document.body)
    expect(screen.queryByRole('button', { name: /signIn.signOut/ })).not.toBeInTheDocument()
  })

  it('links everyone but a viewer to the admin console', async () => {
    const user = userEvent.setup()
    render(<AccountMenu email="operator@example.test" role="operator" />)

    await user.click(screen.getByRole('button', { name: 'signIn.account' }))
    expect(screen.getByRole('link', { name: /signIn.adminConsole/ })).toHaveAttribute('href', '/admin/')
  })

  it('signs out and reloads the page, even when the session was already gone', async () => {
    const assign = vi.spyOn(navigation, 'assign').mockImplementation(() => {})
    vi.mocked(postJSON).mockRejectedValue(new Error('Unauthorized'))
    const user = userEvent.setup()
    render(<AccountMenu email="viewer@example.test" role="viewer" />)

    await user.click(screen.getByRole('button', { name: 'signIn.account' }))
    await user.click(screen.getByRole('button', { name: /signIn.signOut/ }))

    expect(postJSON).toHaveBeenCalledWith('/api/v1/auth/logout')
    expect(assign).toHaveBeenCalledWith('/')
  })
})
