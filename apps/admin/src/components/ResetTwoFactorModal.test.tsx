import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ResetTwoFactorModal } from './ResetTwoFactorModal'

describe('ResetTwoFactorModal', () => {
  it('requires the administrator password and exact user email', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<ResetTwoFactorModal email="operator@example.test" pending={false} onConfirm={onConfirm} onCancel={vi.fn()} />)

    const confirm = screen.getByRole('button', { name: 'Reset 2FA' })
    expect(confirm).toBeDisabled()
    await user.type(screen.getByLabelText('Your current password'), 'admin-password')
    await user.type(screen.getByLabelText(/Type operator@example.test to confirm/), 'operator@example.test')
    await user.click(confirm)
    expect(onConfirm).toHaveBeenCalledWith('admin-password')
  })

  it('shows an API error and disables controls while pending', () => {
    render(<ResetTwoFactorModal email="operator@example.test" pending error="Current password is incorrect" onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('Current password is incorrect')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resetting…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })
})
