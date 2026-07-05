import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeRole } from '../src/routes/auth.js'

describe('role normalization', () => {
  it('preserves supported roles', () => {
    assert.equal(normalizeRole('admin'), 'admin')
    assert.equal(normalizeRole('operator'), 'operator')
    assert.equal(normalizeRole('branding'), 'branding')
  })

  it('supports legacy role arrays', () => {
    assert.equal(normalizeRole('["operator"]'), 'operator')
    assert.equal(normalizeRole('["admin","operator"]'), 'admin')
  })

  it('falls back to the least privileged role', () => {
    assert.equal(normalizeRole('unknown'), 'branding')
    assert.equal(normalizeRole('[]'), 'branding')
    assert.equal(normalizeRole('{"role":"admin"}'), 'branding')
  })
})
