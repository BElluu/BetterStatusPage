// Tries the shared modules (@better-forge/*) from a checkout of Better-Forge without publishing them: builds that
// checkout and copies each package into node_modules/@better-forge/. The packages are copied, not linked, so React,
// Fastify and Drizzle resolve to this repository's single copy. package.json and the lockfile are not touched;
// `npm ci` (npm run kit:reset) puts the released versions back.
//
//   node scripts/kit-local.mjs [--watch]      the checkout is ../Better-Forge, or KIT_DIR
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const kit = path.resolve(process.env['KIT_DIR'] ?? path.join(root, '..', 'Better-Forge'))
const target = path.join(root, 'node_modules', '@better-forge')
const watch = process.argv.includes('--watch')

if (!fs.existsSync(path.join(kit, 'packages'))) {
  console.error(`No Better-Forge checkout at ${kit}. Clone it next to this repository or set KIT_DIR.`)
  process.exit(1)
}

// What a package publishes, besides package.json and the files that npm always includes.
const PARTS = ['dist', 'src', 'styles', 'tailwind-preset.js', 'icons.json', 'LICENSE', 'README.md']

function build() {
  const result = spawnSync('npm run build:kit', { cwd: kit, stdio: 'inherit', shell: true })
  if (result.status !== 0) throw new Error('The Better-Forge build failed.')
}

function copy() {
  const names = fs.readdirSync(path.join(kit, 'packages'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  const versions = new Set()
  for (const name of names) {
    const from = path.join(kit, 'packages', name)
    const manifest = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8'))
    versions.add(manifest.version)
    const to = path.join(target, name)
    fs.rmSync(to, { recursive: true, force: true })
    fs.mkdirSync(to, { recursive: true })
    fs.copyFileSync(path.join(from, 'package.json'), path.join(to, 'package.json'))
    for (const part of PARTS) {
      if (fs.existsSync(path.join(from, part))) fs.cpSync(path.join(from, part), path.join(to, part), { recursive: true })
    }
    // A dependency the module now declares must be installed here, or it would fail at run time.
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (!dep.startsWith('@better-forge/') && !fs.existsSync(path.join(root, 'node_modules', dep))) {
        console.warn(`warning: @better-forge/${name} needs ${dep}, which is not installed here; add it with npm install`)
      }
    }
  }
  console.log(`Copied ${names.length} packages (version ${[...versions].join(', ')}) from ${kit} into node_modules/@better-forge/.`)
}

build()
copy()

if (watch) {
  console.log('Watching the packages; run the Better-Forge build (npm run dev -w @better-forge/<name>) to see changes here.')
  let timer
  fs.watch(path.join(kit, 'packages'), { recursive: true }, (_event, file) => {
    if (!file || !file.split(path.sep).includes('dist')) return
    clearTimeout(timer)
    timer = setTimeout(copy, 300)
  })
}
