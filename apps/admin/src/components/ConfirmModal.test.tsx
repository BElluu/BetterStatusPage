import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmModal } from './ConfirmModal'

describe('ConfirmModal', () => {
  it('renders through a portal and confirms the action', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    render(
      <ConfirmModal
        title="Delete monitor"
        message="This cannot be undone"
        confirmLabel="Remove"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByText('Delete monitor')).toBeInTheDocument()
    expect(screen.getByText('This cannot be undone')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('cancels from the cancel button', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()

    render(
      <ConfirmModal
        title="Confirm"
        message="Continue?"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
