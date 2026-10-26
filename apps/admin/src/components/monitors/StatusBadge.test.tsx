import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ActivityBadges, StatusBadge } from './StatusBadge'

describe('ActivityBadges', () => {
  const quiet = { maintenance: false, windows: [], incident: null }

  it('shows nothing for a monitor with no maintenance, incident or slower-than-usual alert', () => {
    const { container } = render(<ActivityBadges activity={quiet} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a slower-than-usual chip next to the others without touching the status', () => {
    render(<ActivityBadges activity={{ ...quiet, maintenance: true }} slower />)
    expect(screen.getByText('Slower than usual')).toBeInTheDocument()
    expect(screen.getByText('Maintenance')).toBeInTheDocument()
  })
})

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
