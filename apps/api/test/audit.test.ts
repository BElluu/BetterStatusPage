import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { diffObjects, snapshot } from '../src/services/audit.js'

describe('audit helpers', () => {
  it('returns only changed fields', () => {
    assert.deepEqual(
      diffObjects(
        { name: 'API', enabled: true, retries: 1 },
        { name: 'API', enabled: false, retries: 2 },
      ),
      {
        enabled: { from: true, to: false },
        retries: { from: 1, to: 2 },
      },
    )
  })

  it('redacts sensitive values in diffs and snapshots', () => {
    assert.deepEqual(
      diffObjects({ password: 'old' }, { password: 'new' }),
      { password: { from: '[redacted]', to: '[redacted]' } },
    )
    assert.deepEqual(
      snapshot({ username: 'admin', clientSecret: 'secret' }),
      { username: 'admin', clientSecret: '[redacted]' },
    )
  })

  it('detects structural changes', () => {
    assert.deepEqual(
      diffObjects({ tags: ['api'] }, { tags: ['api', 'public'] }),
      { tags: { from: ['api'], to: ['api', 'public'] } },
    )
  })
})
