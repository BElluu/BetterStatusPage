import fs from 'fs'
import path from 'path'

const CONFIG_PATH = path.join(process.cwd(), 'data', 'setup.json')

interface SetupConfig {
  setupComplete: boolean
  dbType: 'sqlite'
}

export function isSetupComplete(): boolean {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return false
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as SetupConfig
    return cfg.setupComplete === true
  } catch {
    return false
  }
}

export function writeSetupComplete(dbType: 'sqlite' = 'sqlite'): void {
  const dir = path.dirname(CONFIG_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ setupComplete: true, dbType }, null, 2))
}
