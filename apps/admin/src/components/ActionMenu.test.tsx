import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ActionMenu } from './ActionMenu'

function setup() {
  const onEdit = vi.fn()
  const onDelete = vi.fn()
  const onOuterKey = vi.fn()
  const view = render(
    <MemoryRouter>
      <div data-testid="page" onKeyDown={onOuterKey}>
        <ActionMenu label="More" items={[
          { label: 'Edit', icon: 'edit', onSelect: onEdit },
          { label: 'Import', icon: 'upload_file', to: '/import' },
          { label: 'Delete', icon: 'delete', onSelect: onDelete, danger: true },
        ]} />
        <button type="button">Elsewhere</button>
      </div>
    </MemoryRouter>,
  )
  return { onEdit, onDelete, onOuterKey, ...view }
}

describe('ActionMenu', () => {
  it('draws the menu in the document body, outside the clipping page container', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name: 'More' }))

    const menu = screen.getByRole('menu', { name: 'More' })
    expect(menu.parentElement).toBe(document.body)
    expect(screen.getByTestId('page')).not.toContainElement(menu)
    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus()
  })

  it('moves between the items with the arrow keys, Home and End, wrapping around', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name: 'More' }))

    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Import' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus()
  })

  it('closes on Escape without letting the page see it, and returns focus to the button', async () => {
    const user = userEvent.setup()
    const { onOuterKey } = setup()
    await user.click(screen.getByRole('button', { name: 'More' }))
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More' })).toHaveFocus()
    expect(onOuterKey).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }))
  })

  it('closes on Tab and on a click outside', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name: 'More' }))
    await user.keyboard('{Tab}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'More' }))
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('runs the chosen action and closes; the button itself toggles the menu', async () => {
    const user = userEvent.setup()
    const { onEdit, onDelete } = setup()
    await user.click(screen.getByRole('button', { name: 'More' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'More' }))
    await user.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('links an item that has a target', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByRole('menuitem', { name: 'Import' })).toHaveAttribute('href', '/import')
  })
})
