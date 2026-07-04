import fs from 'fs'
import path from 'path'

function configPath(): string {
  return process.env['SETUP_CONFIG_PATH'] ?? path.join(process.cwd(), 'data', 'setup.json')
}

interface SetupConfig {
  setupComplete: boolean
  dbType: 'sqlite'
}

export function isSetupComplete(): boolean {
  try {
    const file = configPath()
    if (!fs.existsSync(file)) return false
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8')) as SetupConfig
    return cfg.setupComplete === true
  } catch {
    return false
  }
}

export function writeSetupComplete(dbType: 'sqlite' = 'sqlite'): void {
  const file = configPath()
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ setupComplete: true, dbType }, null, 2))
}
