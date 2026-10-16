import 'dotenv/config'
import { runRestoreCli } from '@better-kit/backup'
import { restoreBackup } from '../services/restore.js'

await runRestoreCli(process.argv, {
  restore: (input, vaultEncryptionKey) => restoreBackup(input, { vaultEncryptionKey }),
  exampleFile: 'bsp-backup-timestamp.backup',
  extra: { flag: '--vault-encryption-key', placeholder: '<64-character-hex-key>' },
})
