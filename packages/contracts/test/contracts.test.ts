import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { baseLanguage, normalizeScopes, requiredScope, tokenAllows, VAULT_USE_SCOPE } from '@better-kit/contracts'

const KNOWN = ['notes:read', 'notes:write', 'stats:read', VAULT_USE_SCOPE]

describe('token permissions', () => {
  it('derive the permission from the HTTP method, with one permission for the vault', () => {
    assert.equal(requiredScope('notes', 'HEAD'), 'notes:read')
    assert.equal(requiredScope('notes', 'DELETE'), 'notes:write')
    assert.equal(requiredScope('vault', 'GET'), VAULT_USE_SCOPE)
  })

  it('let writing include reading and nothing else', () => {
    assert.equal(tokenAllows(['notes:write'], 'notes:read'), true)
    assert.equal(tokenAllows(['notes:read'], 'notes:write'), false)
    assert.equal(tokenAllows(['notes:write'], 'stats:read'), false)
  })

  it('normalise against the catalogue the app passes in', () => {
    assert.deepEqual(normalizeScopes(['notes:write', 'notes:write'], KNOWN), ['notes:read', 'notes:write'])
    for (const bad of [[], ['other:read'], 'notes:read', null, [1]]) assert.equal(normalizeScopes(bad, KNOWN), null)
  })
})

describe('baseLanguage', () => {
  it('keeps only the language of a locale code', () => {
    assert.equal(baseLanguage(' pl-PL '), 'pl')
    assert.equal(baseLanguage('EN_gb'), 'en')
    assert.equal(baseLanguage(''), '')
  })
})
