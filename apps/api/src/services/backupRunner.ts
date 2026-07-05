import { Worker } from 'node:worker_threads'
import type { BackupInfo } from './backup.js'
import { createBackup } from './backup.js'

export function createBackupInWorker(outputDirectory?: string): Promise<BackupInfo> {
  // tsx does not apply its .js-to-.ts resolver inside worker threads. Production
  // always uses the compiled worker; development/tests use the same core inline.
  if (import.meta.url.endsWith('.ts')) return createBackup(outputDirectory)
  return new Promise((resolve, reject) => {
    const moduleUrl = new URL('./backup.js', import.meta.url).href
    const worker = new Worker(new URL('../workers/backupWorker.js', import.meta.url), { workerData: { outputDirectory, moduleUrl } })
    worker.once('message', (message: { result?: BackupInfo; error?: string }) => message.error ? reject(new Error(message.error)) : resolve(message.result!))
    worker.once('error', reject)
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`Backup worker exited with code ${code}`)) })
  })
}
