import { parentPort, workerData } from 'node:worker_threads'

/** The functions the loaded module must export. */
interface BackupModule {
  createBackup: (outputDirectory?: string) => Promise<unknown>
  validateBackup: (input: string) => unknown
}

// Entry of the backup worker thread: import this file from the application's worker script. It loads the module the
// job names, runs the job and posts the result (or the error message) back.
const backup = await import(workerData.moduleUrl as string) as BackupModule
const job = workerData as { task?: 'create' | 'validate'; outputDirectory?: string; input?: string }
const work = job.task === 'validate'
  ? Promise.resolve().then(() => backup.validateBackup(job.input!))
  : backup.createBackup(job.outputDirectory)
work
  .then((result) => parentPort?.postMessage({ result }))
  .catch((error: unknown) => parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) }))
