import { parentPort, workerData } from 'node:worker_threads'

const backup = await import(workerData.moduleUrl as string) as typeof import('../services/backup.js')
const job = workerData as { task?: 'create' | 'validate'; outputDirectory?: string; input?: string }
const work = job.task === 'validate'
  ? Promise.resolve().then(() => backup.validateBackup(job.input!))
  : backup.createBackup(job.outputDirectory)
work
  .then((result) => parentPort?.postMessage({ result }))
  .catch((error: unknown) => parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) }))
