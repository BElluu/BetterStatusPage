import { describe, expect, it } from 'vitest'
import type { Incident } from '@bsp/shared'
import { applyIncidentStatus } from './incidentStatus'

function incident(overrides: Partial<Incident>): Incident {
  return {
    id: 1,
    title: 'Service incident',
    status: 'investigating',
    impact: 'minor',
    startedAt: 1,
    resolvedAt: null,
    createdAt: 1,
    updatedAt: 1,
    monitorIds: [7],
    ...overrides,
  }
}

describe('public monitor incident status', () => {
  it('maps minor incidents to degraded and major incidents to down', () => {
    expect(applyIncidentStatus('up', 7, [incident({ impact: 'minor' })])).toBe('degraded')
    expect(applyIncidentStatus('up', 7, [incident({ impact: 'major' })])).toBe('down')
    expect(applyIncidentStatus('up', 7, [incident({ impact: 'critical' })])).toBe('down')
  })

  it('does not affect unrelated, resolved, or no-impact incidents', () => {
    expect(applyIncidentStatus('up', 8, [incident({ impact: 'critical' })])).toBe('up')
    expect(applyIncidentStatus('up', 7, [incident({ status: 'resolved', impact: 'critical' })])).toBe('up')
    expect(applyIncidentStatus('up', 7, [incident({ impact: 'none' })])).toBe('up')
  })

  it('never hides a more severe technical status', () => {
    expect(applyIncidentStatus('down', 7, [incident({ impact: 'minor' })])).toBe('down')
  })
})
