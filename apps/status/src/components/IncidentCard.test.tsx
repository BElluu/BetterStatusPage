import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Incident, PublicMonitor } from '@bsp/shared'
import { IncidentCard } from './IncidentCard'

vi.mock('../i18n/LocaleContext', () => ({
  useLocale: () => ({
    locale: 'en',
    t: (key: string, vars?: Record<string, string>) => {
      const labels: Record<string, string> = {
        'incident.investigating': 'Investigating',
        'incident.identified': 'Identified',
        'incident.monitoring': 'Monitoring',
        'incident.resolved': 'Resolved',
        'uptime.resolvedIn': `Resolved in ${vars?.['duration'] ?? ''}`,
        'uptime.affected': 'Affected',
      }
      return labels[key] ?? key
    },
  }),
}))

const monitor: PublicMonitor = {
  id: 7,
  name: 'Public API',
  type: 'https',
  currentStatus: 'down',
  lastCheckedAt: null,
}

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 1,
    title: 'API outage',
    status: 'investigating',
    impact: 'major',
    startedAt: Date.UTC(2026, 0, 1, 10),
    resolvedAt: null,
    createdAt: 1,
    updatedAt: 1,
    monitorIds: [monitor.id],
    updates: [{
      id: 1,
      incidentId: 1,
      body: 'Engineers are investigating.',
      status: 'investigating',
      postedAt: Date.UTC(2026, 0, 1, 10, 5),
    }],
    ...overrides,
  }
}

describe('IncidentCard', () => {
  it('renders active incident details, updates, and affected monitors', () => {
    render(<IncidentCard incident={incident()} monitors={[monitor]} />)

    expect(screen.getByText('API outage')).toBeInTheDocument()
    expect(screen.getByText('Investigating')).toBeInTheDocument()
    expect(screen.getByText('Public API')).toBeInTheDocument()
    expect(screen.getByText('Engineers are investigating.')).toBeInTheDocument()
  })

  it('expands the timeline for a resolved incident', async () => {
    const user = userEvent.setup()
    render(
      <IncidentCard
        incident={incident({
          status: 'resolved',
          resolvedAt: Date.UTC(2026, 0, 1, 11),
        })}
        monitors={[monitor]}
      />,
    )

    expect(screen.queryByText('Engineers are investigating.')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /API outage/i }))
    expect(screen.getByText('Engineers are investigating.')).toBeInTheDocument()
    expect(screen.getByText(/Resolved in 1h 0m/)).toBeInTheDocument()
  })

  it('can transition from an active incident to a resolved incident', async () => {
    const user = userEvent.setup()
    const view = render(<IncidentCard incident={incident()} monitors={[monitor]} />)

    view.rerender(
      <IncidentCard
        incident={incident({
          status: 'resolved',
          resolvedAt: Date.UTC(2026, 0, 1, 11),
        })}
        monitors={[monitor]}
      />,
    )

    await user.click(screen.getByRole('button', { name: /API outage/i }))
    expect(screen.getByText('Engineers are investigating.')).toBeInTheDocument()
    expect(screen.getByText(/10:05 UTC/)).toBeInTheDocument()
  })
})
