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

  it('requires the exact confirmation text when configured', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<ConfirmModal title="Delete backup" message="Permanent action" confirmationText="backup.backup" onConfirm={onConfirm} onCancel={vi.fn()} />)

    const confirm = screen.getByRole('button', { name: 'Delete' })
    expect(confirm).toBeDisabled()
    await user.type(screen.getByRole('textbox'), 'wrong')
    expect(confirm).toBeDisabled()
    await user.clear(screen.getByRole('textbox'))
    await user.type(screen.getByRole('textbox'), 'backup.backup')
    await user.click(confirm)
    expect(onConfirm).toHaveBeenCalledOnce()
  })
})
