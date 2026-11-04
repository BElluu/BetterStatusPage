import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ActivityBadges, MonitorStatusBadge, StatusBadge } from './StatusBadge'

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

  it('names how many times slower a monitor is, and falls back when the ratio says no slowdown', () => {
    const activity = { maintenance: false, windows: [], incident: null }
    const { rerender } = render(<ActivityBadges activity={activity} slower slowerRatio={6} />)
    expect(screen.getByText('Slower 6.0×')).toBeInTheDocument()
    expect(screen.getByText('Slower 6.0×')).toHaveAttribute('title', expect.stringContaining('6.0×'))

    // While an alert is open but not over, the p95 may already be near the usual.
    rerender(<ActivityBadges activity={activity} slower slowerRatio={0.8} />)
    expect(screen.getByText('Slower than usual')).toBeInTheDocument()
    rerender(<ActivityBadges activity={activity} slower slowerRatio={null} />)
    expect(screen.getByText('Slower than usual')).toBeInTheDocument()
  })

  it('adds how long a monitor has failed after its status, but not when an incident sets the status', () => {
    const activity = { maintenance: false, windows: [], incident: null }
    const { rerender } = render(<MonitorStatusBadge monitor={{ currentStatus: 'down', activity }} detail="14 min" />)
    expect(screen.getByText('Down 14 min')).toBeInTheDocument()
    rerender(<MonitorStatusBadge monitor={{ currentStatus: 'up', activity: { ...activity, incident: 'major' } }} detail="14 min" />)
    expect(screen.getByText('Down · incident')).toBeInTheDocument()
  })
})
