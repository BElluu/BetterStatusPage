import fs from 'fs'
import path from 'path'

export function dataDir(): string {
  return path.resolve(process.env['DATA_DIR'] ?? path.join(process.cwd(), 'data'))
}

export function databasePath(): string {
  return path.resolve(process.env['DATABASE_PATH'] ?? path.join(dataDir(), 'db.sqlite'))
}

export function uploadDir(): string {
  return path.resolve(process.env['UPLOAD_DIR'] ?? path.join(dataDir(), 'uploads'))
}

export function setupConfigPath(): string {
  return path.resolve(process.env['SETUP_CONFIG_PATH'] ?? path.join(dataDir(), 'setup.json'))
}

export function backupDir(): string {
  return path.resolve(process.env['BACKUP_DIR'] ?? path.join(dataDir(), 'backups'))
}

function configPath(): string {
  return setupConfigPath()
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
