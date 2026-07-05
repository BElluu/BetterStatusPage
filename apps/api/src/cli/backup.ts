import 'dotenv/config'
import path from 'path'
import { initDb, closeDb } from '../db/client.js'
import { createBackup, validateBackup } from '../services/backup.js'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const verifyMode = process.argv.includes('--verify')
  const verify = argument('--input') ?? argument('--verify')
  if (verifyMode) {
    if (!verify || verify.startsWith('--')) throw new Error('Usage: backup:verify -- --input <bsp-backup-timestamp.backup>')
    const manifest = validateBackup(path.resolve(verify))
    console.log(JSON.stringify({ valid: true, manifest }, null, 2))
    return
  }
  initDb()
  try { console.log(JSON.stringify(await createBackup(argument('--output') ? path.resolve(argument('--output')!) : undefined), null, 2)) }
  finally { closeDb() }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
