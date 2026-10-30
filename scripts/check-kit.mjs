// The shared modules (@better-forge/*) come from npm, all at one version. Fails when a manifest or the lockfile points
// at a local copy (`file:`, `link:`), when a package is not resolved from the registry, or when versions are mixed.
//
//   node scripts/check-kit.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
const SCOPE = '@better-forge/'
const problems = []

for (const file of ['package.json', 'apps/api/package.json', 'apps/admin/package.json', 'apps/status/package.json', 'packages/shared/package.json']) {
  const manifest = read(file)
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (name.startsWith(SCOPE) && !/^\d+\.\d+\.\d+$/.test(range)) problems.push(`${file}: ${name} is "${range}"; use the released version, exactly`)
    }
  }
}

const versions = new Set()
for (const [key, entry] of Object.entries(read('package-lock.json').packages)) {
  const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)
  if (!key.includes('node_modules/') || !name.startsWith(SCOPE)) continue
  versions.add(entry.version)
  if (!entry.resolved?.startsWith('https://registry.npmjs.org/')) problems.push(`package-lock.json: ${name} is not resolved from the npm registry`)
}
if (versions.size > 1) problems.push(`package-lock.json holds several versions of the shared modules: ${[...versions].join(', ')}`)

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`@better-forge/* at ${[...versions].join(', ') || 'no version'}`)
