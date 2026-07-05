import { parentPort, workerData } from 'node:worker_threads'

const backup = await import(workerData.moduleUrl as string) as typeof import('../services/backup.js')
backup.createBackup(workerData.outputDirectory as string | undefined)
  .then((result) => parentPort?.postMessage({ result }))
  .catch((error: unknown) => parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) }))
