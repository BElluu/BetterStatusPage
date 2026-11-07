import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { widensSsoProvisioning, type SsoProvisioningSettings } from '../src/index.js'

const on: SsoProvisioningSettings = {
  enabled: true, allowedDomains: ['a.test', 'b.test'], groupsClaim: 'groups',
  groupRoles: [{ group: 'ops', role: 'operator' }, { group: 'all', role: 'viewer' }],
}
const off = { ...on, enabled: false }

describe('widensSsoProvisioning', () => {
  it('is true when it gives more than before', () => {
    assert.equal(widensSsoProvisioning(off, on), true)
    assert.equal(widensSsoProvisioning(on, { ...on, allowedDomains: ['a.test', 'b.test', 'c.test'] }), true)
    assert.equal(widensSsoProvisioning(on, { ...on, allowedDomains: ['c.test'] }), true)
    assert.equal(widensSsoProvisioning(on, { ...on, groupsClaim: 'roles' }), true)
    assert.equal(widensSsoProvisioning(on, { ...on, groupRoles: [{ group: 'ops', role: 'admin' }, { group: 'all', role: 'viewer' }] }), true)
    assert.equal(widensSsoProvisioning(on, { ...on, groupRoles: [...on.groupRoles, { group: 'new', role: 'viewer' }] }), true)
    // A group that is renamed is a new group.
    assert.equal(widensSsoProvisioning(on, { ...on, groupRoles: [{ group: 'ops2', role: 'operator' }, { group: 'all', role: 'viewer' }] }), true)
  })

  it('is false when it gives the same or less, or is off', () => {
    assert.equal(widensSsoProvisioning(on, on), false)
    assert.equal(widensSsoProvisioning(on, off), false)
    assert.equal(widensSsoProvisioning(off, off), false)
    assert.equal(widensSsoProvisioning(on, { ...on, allowedDomains: ['a.test'] }), false)
    assert.equal(widensSsoProvisioning(on, { ...on, groupRoles: [{ group: 'ops', role: 'viewer' }] }), false)
    assert.equal(widensSsoProvisioning(on, { ...on, groupRoles: [{ group: 'all', role: 'viewer' }, { group: 'ops', role: 'operator' }] }), false)
  })
})
