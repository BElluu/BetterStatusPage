import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  generateTotpCode,
  generateTotpSecret,
  hashRecoveryCode,
  totpUri,
  verifyTotp,
} from '../src/crypto/totp.js'

describe('TOTP authentication', () => {
  it('generates and verifies time-based codes with a small clock-skew window', () => {
    const secret = generateTotpSecret()
    const now = 1_750_000_000_000
    const code = generateTotpCode(secret, now)
    assert.match(code, /^\d{6}$/)
    assert.equal(verifyTotp(secret, code, now), true)
    assert.equal(verifyTotp(secret, code, now + 31_000), true)
    assert.equal(verifyTotp(secret, code, now + 61_000), false)
    assert.match(totpUri(secret, 'admin@example.test'), /^otpauth:\/\/totp\//)
  })

  it('hashes and consumes every recovery code only once', () => {
    const codes = generateRecoveryCodes()
    assert.equal(new Set(codes).size, 8)
    const stored = JSON.stringify(codes.map(hashRecoveryCode))
    const consumed = consumeRecoveryCode(stored, codes[0]!)
    assert.equal(consumed.valid, true)
    assert.equal(consumed.remaining.length, 7)
    assert.equal(consumeRecoveryCode(JSON.stringify(consumed.remaining), codes[0]!).valid, false)
  })
})
