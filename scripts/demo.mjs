// Runs this checkout as a throwaway demo: builds the app image, builds the demo image on top of it (the seed from the
// BSPDemo repository adds 90 days of monitors, results, incidents and maintenance), and starts it on port 3000.
// Everything lives in the container and disappears when it stops; open http://localhost:3000 and create the admin
// account in the first-run wizard, the seeded data stays.
//
//   node scripts/demo.mjs [--skip-build]     BSPDemo is ../BSPDemo, or DEMO_DIR; PORT changes the port (default 3000)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const demo = path.resolve(process.env['DEMO_DIR'] ?? path.join(root, '..', 'BSPDemo'))
const instance = path.join(demo, 'instance')
const port = process.env['PORT'] ?? '3000'
const url = `http://localhost:${port}`

if (!fs.existsSync(path.join(instance, 'Dockerfile'))) {
  console.error(`No BSPDemo checkout at ${demo}. Clone it next to this repository or set DEMO_DIR.`)
  process.exit(1)
}

function docker(args) {
  console.log(`\n> docker ${args.join(' ')}\n`)
  const result = spawnSync('docker', args, { cwd: root, stdio: 'inherit' })
  if (result.error) {
    console.error(`Could not run docker: ${result.error.message}. Is Docker installed and running?`)
    process.exit(1)
  }
  return result.status ?? 1
}

function must(args) {
  const status = docker(args)
  if (status !== 0) process.exit(status)
}

if (!process.argv.includes('--skip-build')) {
  must(['build', '-t', 'better-status-page:main', '.'])
  must(['build', '--build-arg', 'BSP_IMAGE=better-status-page:main', '-t', 'bsp-demo-instance:local', instance])
}

console.log(`\nDemo at ${url} (Ctrl+C stops it and removes the data)`)
// The app always listens on 3000 inside the container; only the published port changes.
process.exit(docker([
  'run', '--rm', '-p', `${port}:3000`,
  '-e', 'BSP_DEMO_MODE=true', '-e', `PUBLIC_URL=${url}`, '-e', `ALLOWED_ORIGINS=${url}`,
  'bsp-demo-instance:local',
]))
