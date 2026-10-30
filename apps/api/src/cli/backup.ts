import 'dotenv/config'
import { runBackupCli } from '@better-forge/backup'
import { closeDb, initDb } from '../db/client.js'
import { backup } from '../kit/backup.js'

await runBackupCli(process.argv, { service: backup, database: { open: initDb, close: closeDb }, exampleFile: 'bsp-backup-timestamp.backup' })
