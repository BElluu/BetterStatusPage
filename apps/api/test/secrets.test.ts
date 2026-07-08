import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveJwtSecret, validateVaultEncryptionKey } from '../src/config/secrets.js'

describe('production secret validation', () => {
  it('rejects missing, weak, and placeholder secrets', () => {
    assert.throws(() => resolveJwtSecret({ NODE_ENV: 'production' }), /JWT_SECRET/)
    assert.throws(() => resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'too-short' }), /JWT_SECRET/)
    assert.throws(() => resolveJwtSecret({
      NODE_ENV: 'production', JWT_SECRET: 'change-me-to-a-long-random-string',
    }), /JWT_SECRET/)
    assert.throws(() => validateVaultEncryptionKey({ NODE_ENV: 'production' }), /VAULT_ENCRYPTION_KEY/)
    assert.throws(() => validateVaultEncryptionKey({
      NODE_ENV: 'production', VAULT_ENCRYPTION_KEY: 'z'.repeat(64),
    }), /VAULT_ENCRYPTION_KEY/)
  })

  it('accepts production-grade values', () => {
    assert.equal(resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(32) }), 'a'.repeat(32))
    assert.doesNotThrow(() => validateVaultEncryptionKey({
      NODE_ENV: 'production', VAULT_ENCRYPTION_KEY: 'ab'.repeat(32),
    }))
  })
})
