import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

describe('the package', () => {
  it('says nothing of the products built on it', () => {
    const dir = new URL('../src/', import.meta.url)
    for (const name of fs.readdirSync(dir)) {
      const text = fs.readFileSync(fileURLToPath(new URL(name, dir)), 'utf8')
      assert.doesNotMatch(text, /monitor|incident|status ?page|\bbsp\b|betterstatus/i, name)
    }
  })
})
