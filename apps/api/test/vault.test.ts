import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env['VAULT_ENCRYPTION_KEY'] = '0123456789abcdef'.repeat(4)

const { decrypt, encrypt } = await import('../src/crypto/vault.js')

describe('vault encryption', () => {
  it('round-trips plaintext without storing it in the ciphertext', () => {
    const plaintext = 'correct horse battery staple'
    const ciphertext = encrypt(plaintext)

    assert.notEqual(ciphertext, plaintext)
    assert.equal(ciphertext.split(':').length, 3)
    assert.equal(decrypt(ciphertext), plaintext)
  })

  it('uses a unique IV for each encryption', () => {
    assert.notEqual(encrypt('same value'), encrypt('same value'))
  })

  it('rejects malformed and tampered ciphertext', () => {
    assert.throws(() => decrypt('invalid'), /Invalid ciphertext format/)

    const [iv, tag, encrypted] = encrypt('secret').split(':') as [string, string, string]
    const tampered = `${iv}:${tag}:${encrypted.slice(0, -2)}00`
    assert.throws(() => decrypt(tampered))
  })
})
