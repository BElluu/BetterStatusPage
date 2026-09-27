import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Modal, ModalShell, MODAL_BACKDROP, MODAL_Z_INDEX } from './ModalShell'

describe('ModalShell', () => {
  it('portals its content to the body above the page with the shared backdrop', () => {
    const { container } = render(<ModalShell><p>Dialog body</p></ModalShell>)

    expect(container).toBeEmptyDOMElement()
    const backdrop = screen.getByTestId('modal-backdrop')
    expect(backdrop.parentElement).toBe(document.body)
    expect(backdrop).toHaveStyle({ position: 'fixed', zIndex: String(MODAL_Z_INDEX), background: MODAL_BACKDROP })
    expect(screen.getByText('Dialog body')).toBeInTheDocument()
  })

  it('centres short dialogs and top-aligns tall forms', () => {
    const { unmount } = render(<ModalShell><p>Short</p></ModalShell>)
    expect(screen.getByText('Short').parentElement).toHaveStyle({ alignItems: 'center' })
    unmount()

    render(<ModalShell align="top"><p>Tall</p></ModalShell>)
    expect(screen.getByText('Tall').parentElement).toHaveStyle({ alignItems: 'flex-start' })
  })
})

describe('Modal', () => {
  it('closes from its close button but not from a backdrop click', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Modal title="Create Vault" onClose={onClose}><input aria-label="Name" /></Modal>)

    expect(screen.getByRole('dialog', { name: 'Create Vault' })).toBeInTheDocument()
    await user.click(screen.getByTestId('modal-backdrop'))
    await user.click(screen.getByLabelText('Name'))
    expect(onClose).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
