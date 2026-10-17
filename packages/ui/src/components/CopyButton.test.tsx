import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CopyButton } from './CopyButton'

describe('CopyButton', () => {
  it('copies the value and confirms the action', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    render(<CopyButton value="temporary-secret" label="Copy codes" />)

    await user.click(screen.getByRole('button', { name: /Copy codes/ }))

    expect(writeText).toHaveBeenCalledWith('temporary-secret')
    expect(screen.getByRole('button', { name: /Copied!/ })).toHaveAttribute('data-copied', 'true')
  })

  it('reports a failed copy', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    render(<CopyButton value="secret" />)

    await user.click(screen.getByRole('button', { name: 'Copy' }))

    expect(await screen.findByRole('button', { name: 'Copy failed' })).toHaveAttribute('data-failed', 'true')
  })

  it('names an icon-only button through its label', () => {
    render(<CopyButton value="secret" label="Copy token" iconOnly />)
    const button = screen.getByRole('button', { name: 'Copy token' })
    expect(button).toHaveAttribute('title', 'Copy token')
    expect(button).not.toHaveTextContent('Copy token')
  })
})
