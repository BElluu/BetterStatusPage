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
    // Flip every bit of the last byte so the ciphertext always changes (overwriting with a fixed byte is a no-op 1/256 of the time)
    const lastByte = (parseInt(encrypted.slice(-2), 16) ^ 0xff).toString(16).padStart(2, '0')
    const tampered = `${iv}:${tag}:${encrypted.slice(0, -2)}${lastByte}`
    assert.throws(() => decrypt(tampered))
  })
})
