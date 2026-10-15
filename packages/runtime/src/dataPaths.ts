import fs from 'node:fs'
import path from 'node:path'

type Env = NodeJS.ProcessEnv

/** Where the application keeps its data: `DATA_DIR`, else `./data` under the working directory. */
export function dataDir(env: Env = process.env): string {
  return path.resolve(env['DATA_DIR'] ?? path.join(process.cwd(), 'data'))
}

/** The SQLite file: `DATABASE_PATH`, else `db.sqlite` in the data directory. */
export function databasePath(env: Env = process.env): string {
  return path.resolve(env['DATABASE_PATH'] ?? path.join(dataDir(env), 'db.sqlite'))
}

/** The file that records the first-run setup was completed: `SETUP_CONFIG_PATH`, else `setup.json` in the data directory. */
export function setupConfigPath(env: Env = process.env): string {
  return path.resolve(env['SETUP_CONFIG_PATH'] ?? path.join(dataDir(env), 'setup.json'))
}

/** Where backups are written: `BACKUP_DIR`, else `backups` in the data directory. */
export function backupDir(env: Env = process.env): string {
  return path.resolve(env['BACKUP_DIR'] ?? path.join(dataDir(env), 'backups'))
}

interface SetupConfig {
  setupComplete: boolean
  dbType: 'sqlite'
}

export function isSetupComplete(env: Env = process.env): boolean {
  try {
    const file = setupConfigPath(env)
    if (!fs.existsSync(file)) return false
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8')) as SetupConfig
    return cfg.setupComplete === true
  } catch {
    return false
  }
}

export function writeSetupComplete(dbType: 'sqlite' = 'sqlite', env: Env = process.env): void {
  const file = setupConfigPath(env)
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ setupComplete: true, dbType }, null, 2))
}
