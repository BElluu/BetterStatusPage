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
})
