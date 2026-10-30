import 'dotenv/config'
import { runRestoreCli } from '@better-forge/backup'
import { restoreBackup } from '../kit/backup.js'

await runRestoreCli(process.argv, {
  restore: (input, vaultEncryptionKey) => restoreBackup(input, { vaultEncryptionKey }),
  exampleFile: 'bsp-backup-timestamp.backup',
  extra: { flag: '--vault-encryption-key', placeholder: '<64-character-hex-key>' },
})
