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

  it('closes on Escape only when onClose is given', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { unmount } = render(<ModalShell><p>No handler</p></ModalShell>)
    await user.keyboard('{Escape}')
    unmount()

    render(<ModalShell onClose={onClose}><p>Handler</p></ModalShell>)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('lets Escape close only the topmost of stacked modals', async () => {
    const user = userEvent.setup()
    const outer = vi.fn()
    const inner = vi.fn()
    render(<>
      <ModalShell onClose={outer}><p>Outer</p></ModalShell>
      <ModalShell onClose={inner}><p>Inner</p></ModalShell>
    </>)

    await user.keyboard('{Escape}')
    expect(inner).toHaveBeenCalledOnce()
    expect(outer).not.toHaveBeenCalled()
  })

  it('becomes the dialog itself when given a label', () => {
    render(<ModalShell label="Edit incident"><p>Form</p></ModalShell>)
    expect(screen.getByRole('dialog', { name: 'Edit incident' })).toHaveAttribute('aria-modal', 'true')
  })

  it('moves focus inside, keeps an autofocused field, traps Tab and restores focus on close', async () => {
    const user = userEvent.setup()
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()

    const { unmount } = render(<ModalShell label="Form"><input aria-label="First" autoFocus /><button type="button">Last</button></ModalShell>)
    expect(screen.getByLabelText('First')).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus()
    await user.tab()
    expect(screen.getByLabelText('First')).toHaveFocus()
    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus()

    unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })

  it('focuses the panel when nothing inside asked for focus', () => {
    render(<ModalShell label="Info"><p>Read only</p></ModalShell>)
    expect(screen.getByRole('dialog', { name: 'Info' })).toHaveFocus()
  })
})

describe('Modal', () => {
  it('closes from its close button but not from a backdrop click', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Modal title="Create Vault" icon="shield_lock" onClose={onClose}><input aria-label="Name" /></Modal>)

    expect(screen.getByRole('dialog', { name: 'Create Vault' })).toBeInTheDocument()
    await user.click(screen.getByTestId('modal-backdrop'))
    await user.click(screen.getByLabelText('Name'))
    expect(onClose).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Modal title="Create Vault" icon="shield_lock" onClose={onClose}><input aria-label="Name" /></Modal>)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })
})
