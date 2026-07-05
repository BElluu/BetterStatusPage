import 'dotenv/config'
import path from 'path'
import { restoreBackup } from '../services/restore.js'

const inputIndex = process.argv.indexOf('--input')
const input = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined
const keyIndex = process.argv.indexOf('--vault-encryption-key')
const vaultEncryptionKey = keyIndex >= 0 ? process.argv[keyIndex + 1] : undefined
if (!input || !vaultEncryptionKey) {
  console.error('Usage: restore --input <bsp-backup-timestamp.backup> --vault-encryption-key <64-character-hex-key>')
  process.exitCode = 1
} else {
  restoreBackup(path.resolve(input), { vaultEncryptionKey })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
}
