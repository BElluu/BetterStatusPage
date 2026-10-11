import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { API_TOKEN_SCOPES, normalizeScopes, requiredScope, TOKEN_PRESETS, TOKEN_RESOURCES, tokenAllows, VAULT_USE_SCOPE } from '@bsp/shared'

describe('what a token needs for a request', () => {
  it('is the read permission for GET and HEAD and the write permission for anything else', () => {
    for (const method of ['GET', 'HEAD']) assert.equal(requiredScope('monitors', method), 'monitors:read')
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(requiredScope('monitors', method), 'monitors:write')
  })

  it('is the single vault permission for the vault catalogue, whatever the method', () => {
    for (const method of ['GET', 'POST']) assert.equal(requiredScope('vault', method), VAULT_USE_SCOPE)
  })

  it('can never be met for a change to a part that has nothing to change', () => {
    for (const part of ['audit', 'system', 'reports']) {
      assert.equal(API_TOKEN_SCOPES.includes(requiredScope(part, 'POST')), false, part)
      assert.equal(tokenAllows(API_TOKEN_SCOPES, requiredScope(part, 'POST')), false, part)
    }
  })
})

describe('tokenAllows', () => {
  it('lets writing include reading, and nothing else include anything', () => {
    assert.equal(tokenAllows(['monitors:write'], 'monitors:read'), true)
    assert.equal(tokenAllows(['monitors:read'], 'monitors:write'), false)
    assert.equal(tokenAllows(['monitors:write'], 'incidents:read'), false)
    assert.equal(tokenAllows(['vault:use'], 'monitors:read'), false)
    assert.equal(tokenAllows([], 'monitors:read'), false)
  })
})

describe('normalizeScopes', () => {
  it('adds reading to writing, drops repeats and orders by the catalogue', () => {
    assert.deepEqual(normalizeScopes(['incidents:write', 'monitors:read', 'incidents:write']), ['monitors:read', 'incidents:read', 'incidents:write'])
  })

  it('refuses an empty list, an unknown permission and anything that is not a list of text', () => {
    for (const bad of [[], ['monitors'], ['monitors:delete'], ['monitors:read', 'oops'], 'monitors:read', null, undefined, [1], {}]) {
      assert.equal(normalizeScopes(bad), null, JSON.stringify(bad))
    }
  })

  it('is stable: normalising a normal list changes nothing', () => {
    assert.deepEqual(normalizeScopes(API_TOKEN_SCOPES), [...API_TOKEN_SCOPES])
  })
})

describe('the catalogue', () => {
  it('lists every part with the levels it has, and the presets only use known permissions', () => {
    assert.equal(API_TOKEN_SCOPES.length, TOKEN_RESOURCES.reduce((count, resource) => count + resource.levels.length, 0) + 1)
    for (const preset of TOKEN_PRESETS) {
      const normalized = normalizeScopes(preset.scopes)
      assert.ok(normalized, preset.label)
      for (const scope of preset.scopes) assert.ok(normalized.includes(scope), `${preset.label}: ${scope}`)
    }
  })
})
