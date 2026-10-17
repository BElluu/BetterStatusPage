import { Worker } from 'node:worker_threads'
import type { BackupInfo, BackupManifest, BackupService } from './service.js'

export type BackupJob =
  | { task: 'create'; outputDirectory?: string | undefined }
  | { task: 'validate'; input: string }

export interface BackupWorkerOptions {
  /** The worker script: the application's file that imports `@better-kit/backup/worker`. */
  workerUrl: URL
  /** The module the worker loads; it exports `createBackup` and `validateBackup`. */
  moduleUrl: string
  execArgv?: string[]
}

/** Runs one backup job on a worker thread; exposed with explicit URLs so tests can drive the real worker. */
export function spawnBackupWorker<T>(job: BackupJob, options: BackupWorkerOptions): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(options.workerUrl, { workerData: { ...job, moduleUrl: options.moduleUrl }, execArgv: options.execArgv })
    worker.once('message', (message: { result?: T; error?: string }) => message.error ? reject(new Error(message.error)) : resolve(message.result!))
    worker.once('error', reject)
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`Backup worker exited with code ${code}`)) })
  })
}

/**
 * Backups and verification off the event loop. With `inline` (development and tests, where the worker thread cannot
 * load TypeScript) the same core runs in the calling thread instead.
 */
export function createBackupRunner<Manifest extends BackupManifest>(options: BackupWorkerOptions & {
  service: BackupService<Manifest>
  inline: boolean
}) {
  function run<T>(job: BackupJob, inline: () => Promise<T>): Promise<T> {
    return options.inline ? inline() : spawnBackupWorker(job, options)
  }

  return {
    createBackup: (outputDirectory?: string): Promise<BackupInfo> =>
      run({ task: 'create', outputDirectory }, () => options.service.createBackup(outputDirectory)),
    /** Extraction and the SQLite integrity check are synchronous, so keep them off the event loop. */
    validateBackup: (input: string): Promise<Manifest> =>
      run({ task: 'validate', input }, async () => options.service.validateBackup(input)),
  }
}
