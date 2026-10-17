import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const sourceDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

describe('auth package sources', () => {
  it('never redirect to a literal path: where the product lives comes from the urls it passes in', () => {
    for (const name of fs.readdirSync(sourceDir).filter((entry) => entry.endsWith('.ts'))) {
      const code = fs.readFileSync(path.join(sourceDir, name), 'utf8')
      assert.doesNotMatch(code, /\.redirect\(\s*[`'"]\//, `${name} redirects to a literal path`)
    }
  })
})
