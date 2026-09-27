import { Worker } from 'node:worker_threads'
import type { BackupInfo, BackupManifest } from './backup.js'
import { createBackup, validateBackup } from './backup.js'

export type BackupJob =
  | { task: 'create'; outputDirectory?: string | undefined }
  | { task: 'validate'; input: string }

export interface BackupWorkerOptions { workerUrl: URL; moduleUrl: string; execArgv?: string[] }

/** Runs one backup job on a worker thread; exposed with explicit URLs so tests can drive the real worker. */
export function spawnBackupWorker<T>(job: BackupJob, options: BackupWorkerOptions): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(options.workerUrl, { workerData: { ...job, moduleUrl: options.moduleUrl }, execArgv: options.execArgv })
    worker.once('message', (message: { result?: T; error?: string }) => message.error ? reject(new Error(message.error)) : resolve(message.result!))
    worker.once('error', reject)
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`Backup worker exited with code ${code}`)) })
  })
}

function runInWorker<T>(job: BackupJob, inline: () => Promise<T>): Promise<T> {
  // tsx does not apply its .js-to-.ts resolver inside worker threads. Production
  // always uses the compiled worker; development/tests use the same core inline.
  if (import.meta.url.endsWith('.ts')) return inline()
  return spawnBackupWorker(job, {
    workerUrl: new URL('../workers/backupWorker.js', import.meta.url),
    moduleUrl: new URL('./backup.js', import.meta.url).href,
  })
}

export function createBackupInWorker(outputDirectory?: string): Promise<BackupInfo> {
  return runInWorker({ task: 'create', outputDirectory }, () => createBackup(outputDirectory))
}

/** Extraction and the SQLite integrity check are synchronous, so keep them off the event loop. */
export function validateBackupInWorker(input: string): Promise<BackupManifest> {
  return runInWorker({ task: 'validate', input }, async () => validateBackup(input))
}
