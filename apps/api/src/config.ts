import path from 'node:path'
import { dataDir } from '@better-forge/runtime'

// Where the data lives is decided by the runtime package; the upload folder is this application's own.
export { backupDir, dataDir, databasePath, isSetupComplete, setupConfigPath, writeSetupComplete } from '@better-forge/runtime'

export function uploadDir(): string {
  return path.resolve(process.env['UPLOAD_DIR'] ?? path.join(dataDir(), 'uploads'))
}
