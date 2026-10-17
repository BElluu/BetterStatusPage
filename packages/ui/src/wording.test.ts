import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.dirname(fileURLToPath(import.meta.url))
const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(dir, entry.name)
  if (entry.isDirectory()) return entry.name === 'testing' ? [] : sources(file)
  return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [file] : []
})

describe('the interface package', () => {
  it('says nothing of the products built on it', () => {
    for (const file of [...sources(root), path.join(root, '..', 'styles', 'base.css'), path.join(root, '..', 'tailwind-preset.js')]) {
      expect(fs.readFileSync(file, 'utf8'), path.relative(root, file)).not.toMatch(/monitor|incident|status ?page|betterstatus|\bbsp\b|subscriber/i)
    }
  })
})
