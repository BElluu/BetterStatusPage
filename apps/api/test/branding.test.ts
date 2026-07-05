import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { detectImageMime } from '../src/routes/branding.js'

describe('branding image validation', () => {
  it('recognizes supported image signatures', () => {
    assert.equal(detectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'image/png')
    assert.equal(detectImageMime(Buffer.from([0xff, 0xd8, 0xff])), 'image/jpeg')
    assert.equal(detectImageMime(Buffer.from([0x47, 0x49, 0x46, 0x38])), 'image/gif')
    assert.equal(detectImageMime(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'image/webp')
  })

  it('rejects spoofed and unsupported files', () => {
    assert.equal(detectImageMime(Buffer.from('not an image')), null)
    assert.equal(detectImageMime(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x42, 0x41, 0x44, 0x21])), null)
  })
})
