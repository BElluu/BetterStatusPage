import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusBadge } from './StatusBadge'

describe('StatusBadge', () => {
  it.each([
    ['up', 'Operational'],
    ['down', 'Down'],
    ['degraded', 'Degraded'],
    ['pending', 'Pending'],
    ['affected', 'Dep. Issue'],
  ] as const)('renders %s status as %s', (status, label) => {
    render(<StatusBadge status={status} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })
})
