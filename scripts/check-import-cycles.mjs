// Fails when a file under apps/api/src/kit is part of an import cycle.
//
// The files in kit/ create each module's instance and export its members at load time
// (`export const { requireAuth } = auth.middleware`). When a cycle runs through one of them, a module that needs the
// instance can load before it exists, which fails at start-up with a ReferenceError, and only for some entry points.
// Type-only imports are ignored: they are erased at compile time.
//
//   node scripts/check-import-cycles.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'apps', 'api', 'src')
const kit = path.join(source, 'kit') + path.sep

const files = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (file.endsWith('.ts') && !file.endsWith('.d.ts')) files.push(file)
  }
}
walk(source)
const known = new Set(files)

const importsOf = (file) => {
  const text = fs.readFileSync(file, 'utf8')
  const targets = []
  const resolve = (specifier) => {
    const target = path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts'))
    if (known.has(target)) targets.push(target)
  }
  for (const match of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?([^'"]*?)\s*from\s*['"](\.[^'"]+)['"]/gm)) {
    if (match[1]) continue
    const names = match[2].trim()
    const onlyTypes = /^\{[^}]*\}$/.test(names) && names.slice(1, -1).split(',').map((name) => name.trim()).filter(Boolean).every((name) => name.startsWith('type '))
    if (!onlyTypes) resolve(match[3])
  }
  for (const match of text.matchAll(/^\s*import\s+['"](\.[^'"]+)['"]/gm)) resolve(match[1])
  return targets
}

const graph = new Map(files.map((file) => [file, importsOf(file)]))

// Tarjan's strongly connected components: every group of more than one file is a cycle.
let counter = 0
const stack = []
const onStack = new Set()
const index = new Map()
const low = new Map()
const cycles = []
const visit = (file) => {
  index.set(file, counter)
  low.set(file, counter)
  counter += 1
  stack.push(file)
  onStack.add(file)
  for (const next of graph.get(file)) {
    if (!index.has(next)) { visit(next); low.set(file, Math.min(low.get(file), low.get(next))) }
    else if (onStack.has(next)) low.set(file, Math.min(low.get(file), index.get(next)))
  }
  if (low.get(file) === index.get(file)) {
    const group = []
    let member
    do { member = stack.pop(); onStack.delete(member); group.push(member) } while (member !== file)
    if (group.length > 1) cycles.push(group)
  }
}
for (const file of files) if (!index.has(file)) visit(file)

const relative = (file) => path.relative(source, file).split(path.sep).join('/')
const throughKit = cycles.filter((group) => group.some((file) => file.startsWith(kit)))
if (throughKit.length === 0) {
  console.log(`No import cycle runs through kit/ (${files.length} files checked)`)
} else {
  for (const group of throughKit) console.error(`Import cycle through kit/: ${group.map(relative).join(' <-> ')}`)
  process.exitCode = 1
}
