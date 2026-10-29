// Builds and tests each shared package on its own: in a temporary directory that holds the package, the built copies
// of the Better packages it declares (and what they declare in turn) and links to the third-party packages those
// declare, and nothing else. An import of something nobody declared fails here, as it would for someone who installs
// the package alone.
//
//   node scripts/check-isolation.mjs [package ...]      (build everything first: npm run build:kit)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCOPE = '@better-forge/'
// Their tests run in a browser-like environment under the root vitest configuration, so only their build is checked here.
const BUILD_ONLY = new Set(['ui'])

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const packageDir = (name) => path.join(root, 'packages', name.slice(SCOPE.length))
const declared = (manifest) => Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies })

/** The Better packages a package needs at run time, and theirs. */
function workspaceClosure(names, seen = new Set()) {
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    workspaceClosure(declared(readJson(path.join(packageDir(name), 'package.json'))).filter((dep) => dep.startsWith(SCOPE)), seen)
  }
  return seen
}

function copyPackage(name, destination) {
  const source = path.join(root, 'packages', name)
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of ['package.json', 'dist', 'styles', 'tailwind-preset.js']) {
    const from = path.join(source, entry)
    if (fs.existsSync(from)) fs.cpSync(from, path.join(destination, entry), { recursive: true })
  }
}

function link(name, nodeModules) {
  const target = path.join(root, 'node_modules', name)
  if (!fs.existsSync(target)) return
  const at = path.join(nodeModules, name)
  fs.mkdirSync(path.dirname(at), { recursive: true })
  if (!fs.existsSync(at)) fs.symlinkSync(target, at, 'junction')
}

/** Takes the links out one by one first: removing a directory tree must never follow one into the real packages. */
function remove(directory) {
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (fs.lstatSync(file).isSymbolicLink()) { try { fs.unlinkSync(file) } catch { fs.rmdirSync(file) } }
      else if (entry.isDirectory()) visit(file)
    }
  }
  if (fs.existsSync(path.join(directory, 'node_modules'))) visit(path.join(directory, 'node_modules'))
  fs.rmSync(directory, { recursive: true, force: true })
}

function run(command, args, cwd) {
  return spawnSync(process.execPath, [command, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } })
}

const wanted = process.argv.slice(2)
const packages = fs.readdirSync(path.join(root, 'packages'))
  .filter((name) => name !== 'shared' && fs.existsSync(path.join(root, 'packages', name, 'package.json')))
  .filter((name) => wanted.length === 0 || wanted.includes(name))

let failed = 0
for (const name of packages) {
  const manifest = readJson(path.join(root, 'packages', name, 'package.json'))
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kit-isolated-${name}-`))
  try {
    const home = path.join(temp, 'packages', name)
    fs.mkdirSync(home, { recursive: true })
    fs.copyFileSync(path.join(root, 'tsconfig.base.json'), path.join(temp, 'tsconfig.base.json'))
    for (const entry of ['package.json', 'tsconfig.json', 'src', 'test']) {
      const from = path.join(root, 'packages', name, entry)
      if (fs.existsSync(from)) fs.cpSync(from, path.join(home, entry), { recursive: true })
    }

    const nodeModules = path.join(home, 'node_modules')
    const ours = workspaceClosure(declared(manifest).filter((dep) => dep.startsWith(SCOPE)))
    ours.delete(`${SCOPE}${name}`)
    const thirdParty = new Set(declared(manifest))
    for (const dep of ours) {
      copyPackage(dep.slice(SCOPE.length), path.join(nodeModules, dep))
      for (const inner of declared(readJson(path.join(packageDir(dep), 'package.json')))) thirdParty.add(inner)
    }
    for (const dep of thirdParty) if (!dep.startsWith(SCOPE)) link(dep, nodeModules)
    // The package itself, so its tests can import it by name as an application would.
    copyPackage(name, path.join(nodeModules, SCOPE + name))
    fs.rmSync(path.join(nodeModules, SCOPE + name, 'dist'), { recursive: true, force: true })

    const build = run(path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), ['-p', 'tsconfig.json'], home)
    let status = build.status === 0 ? 'built' : 'BUILD FAILED'
    let output = build.stdout + build.stderr
    if (build.status === 0) {
      fs.cpSync(path.join(home, 'dist'), path.join(nodeModules, SCOPE + name, 'dist'), { recursive: true })
      if (!BUILD_ONLY.has(name) && fs.existsSync(path.join(home, 'test'))) {
        const tsx = pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href
        const tested = run('--import', [tsx, '--test', ...fs.readdirSync(path.join(home, 'test')).filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`)], home)
        status = tested.status === 0 ? 'built, tests pass' : 'TESTS FAILED'
        output = tested.stdout + tested.stderr
        const summary = /ℹ tests (\d+)/.exec(output)
        if (tested.status === 0 && summary) status += ` (${summary[1]})`
      } else if (BUILD_ONLY.has(name)) status += ' (tests run by the root vitest)'
    }
    const failedHere = status.includes('FAILED')
    if (failedHere) failed++
    console.log(`${failedHere ? '✖' : '✔'} ${name}: ${status}`)
    if (failedHere) console.log(output.split('\n').filter((line) => /error|Cannot find|ERR_|✖|not found/i.test(line)).slice(0, 12).join('\n'))
  } finally {
    if (process.env['KEEP_ISOLATION']) console.log('kept', temp)
    else remove(temp)
  }
}
process.exitCode = failed ? 1 : 0
