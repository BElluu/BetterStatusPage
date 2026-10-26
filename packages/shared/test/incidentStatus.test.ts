import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Incident } from '../src/types/incident.js'
import { applyIncidentStatus, withIncidentImpact } from '../src/incidentStatus.js'

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
    draft: false,
    autoMonitorId: null,
    monitorIds: [7],
    ...overrides,
  }
}

describe('incident status', () => {
  it('maps minor incidents to degraded and major incidents to down', () => {
    assert.equal(applyIncidentStatus('up', 7, [incident({ impact: 'minor' })]), 'degraded')
    assert.equal(applyIncidentStatus('up', 7, [incident({ impact: 'major' })]), 'down')
    assert.equal(applyIncidentStatus('up', 7, [incident({ impact: 'critical' })]), 'down')
  })

  it('does not affect unrelated or resolved incidents', () => {
    assert.equal(applyIncidentStatus('up', 8, [incident({ impact: 'critical' })]), 'up')
    assert.equal(applyIncidentStatus('up', 7, [incident({ status: 'resolved', impact: 'critical' })]), 'up')
  })

  it('never hides a more severe check result', () => {
    assert.equal(applyIncidentStatus('down', 7, [incident({ impact: 'minor' })]), 'down')
    assert.equal(withIncidentImpact('down', 'minor'), 'down')
  })

  it('takes the worst of several open incidents', () => {
    const incidents = [incident({ id: 1, impact: 'minor' }), incident({ id: 2, impact: 'major' })]
    assert.equal(applyIncidentStatus('up', 7, incidents), 'down')
  })

  it('leaves the check result alone without an impact', () => {
    assert.equal(withIncidentImpact('up', null), 'up')
    assert.equal(withIncidentImpact('pending', undefined), 'pending')
  })
})
