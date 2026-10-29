// Builds the shared packages (packages/*, the @better-forge scope) in dependency order and leaves a package alone when
// nothing it is built from changed since its last build: no source, manifest or compiler setting is newer than its
// output, and no package it depends on was rebuilt in this run. A missing `dist` always builds.
//
//   node scripts/build-kit.mjs [--force]      (--force builds every package)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCOPE = '@better-forge/'
const force = process.argv.includes('--force')
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const packages = new Map()
for (const dir of fs.readdirSync(path.join(root, 'packages'))) {
  const manifestFile = path.join(root, 'packages', dir, 'package.json')
  if (!fs.existsSync(manifestFile)) continue
  const manifest = readJson(manifestFile)
  if (!manifest.name?.startsWith(SCOPE)) continue
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies })
  packages.set(manifest.name, { dir: path.join(root, 'packages', dir), needs: declared.filter((name) => name.startsWith(SCOPE)) })
}

/** Dependencies first. */
const order = []
const visit = (name, trail = []) => {
  if (order.includes(name)) return
  if (trail.includes(name)) throw new Error(`Circular dependency between shared packages: ${[...trail, name].join(' -> ')}`)
  for (const need of packages.get(name)?.needs ?? []) if (packages.has(need)) visit(need, [...trail, name])
  order.push(name)
}
for (const name of packages.keys()) visit(name)

/** The newest modification time under a path, directories included so that a deleted file counts as a change. */
function newest(target) {
  if (!fs.existsSync(target)) return 0
  const stat = fs.statSync(target)
  if (!stat.isDirectory()) return stat.mtimeMs
  let latest = stat.mtimeMs
  for (const entry of fs.readdirSync(target)) latest = Math.max(latest, newest(path.join(target, entry)))
  return latest
}

const compilerSettings = newest(path.join(root, 'tsconfig.base.json'))
const rebuilt = new Set()
let skipped = 0

for (const name of order) {
  const { dir, needs } = packages.get(name)
  const output = path.join(dir, 'dist', 'index.js')
  const builtAt = fs.existsSync(output) ? fs.statSync(output).mtimeMs : 0
  const inputs = Math.max(compilerSettings, newest(path.join(dir, 'src')), newest(path.join(dir, 'package.json')), newest(path.join(dir, 'tsconfig.json')))
  const stale = force || builtAt === 0 || inputs > builtAt || needs.some((need) => rebuilt.has(need))
  if (!stale) { skipped += 1; continue }

  console.log(`> building ${name}`)
  // Every package builds with `tsc -p tsconfig.json`, as its `build` script says; calling it directly skips the npm start-up.
  const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: dir, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
  rebuilt.add(name)
}

console.log(`Shared packages: ${rebuilt.size} built, ${skipped} up to date`)
