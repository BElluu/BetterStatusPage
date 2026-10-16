import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SidePanelFrame, SideTabStrip } from './SidePanel'

const META = { auth: { icon: 'lock', label: 'Auth' }, tags: { icon: 'label', label: 'Tags' } }

describe('SidePanelFrame', () => {
  it('keeps a minimum width only from the lg breakpoint and stacks in responsive layout', () => {
    const { rerender } = render(<SidePanelFrame meta={META.auth}><p>Body</p></SidePanelFrame>)
    const frame = screen.getByTestId('side-panel-frame')
    expect(frame).toHaveClass('min-w-0', 'lg:min-w-[360px]', 'border-l')
    expect(screen.getByText('Auth')).toBeInTheDocument()

    rerender(<SidePanelFrame meta={META.auth} layout="responsive"><p>Body</p></SidePanelFrame>)
    expect(frame).toHaveClass('w-full', 'border-t', 'lg:border-l', 'lg:border-t-0')
  })
})

describe('SideTabStrip', () => {
  it('toggles sections and exposes the pressed state', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const { rerender } = render(<SideTabStrip tabs={[{ key: 'auth', badge: null }, { key: 'tags', badge: '2' }]} meta={META} active={null} onToggle={onToggle} />)

    await user.click(screen.getByRole('button', { name: 'Tags' }))
    expect(onToggle).toHaveBeenCalledWith('tags')
    expect(screen.getByText('2')).toBeInTheDocument()

    rerender(<SideTabStrip tabs={[{ key: 'auth', badge: null }, { key: 'tags', badge: '2' }]} meta={META} active="tags" onToggle={onToggle} layout="responsive" />)
    expect(screen.getByRole('button', { name: 'Tags' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Tags' }))
    expect(onToggle).toHaveBeenLastCalledWith(null)
    expect(screen.getByRole('toolbar')).toHaveClass('flex-row', 'lg:flex-col')
  })
})
