import cron, { type ScheduledTask } from 'node-cron'
import type { NotifyEngine } from './engine.js'

/** Work the application runs on the same ticks as the deliveries. A rejection is logged under `failure`, never thrown. */
export interface WorkerTask {
  /** The line logged when the task fails (the error follows it). */
  failure: string
  run: () => Promise<unknown>
}

export interface DeliveryWorkerOptions {
  engine: Pick<NotifyEngine, 'processDue' | 'purgeOldDeliveries'>
  /** Run every 30 seconds beside the sending of due deliveries (retries, digests that came due). */
  retryTasks?: readonly WorkerTask[]
  /** Run daily at 03:00 beside the purge of old delivery history. */
  purgeTasks?: readonly WorkerTask[]
  /** Prefix of the line logged when the worker starts. */
  logPrefix?: string
}

/**
 * Sends the deliveries that came due (retries and digests) every 30 seconds and purges old history daily. Does not
 * wait for a pass to finish before the next one is due; the engine takes care of overlapping passes.
 */
export function createDeliveryWorker(options: DeliveryWorkerOptions) {
  let retryTask: ScheduledTask | null = null
  let purgeTask: ScheduledTask | null = null

  const tasks = (list: readonly WorkerTask[]) => {
    for (const task of list) task.run().catch((error) => console.error(task.failure, error))
  }

  function start(): void {
    if (retryTask || purgeTask) return
    retryTask = cron.schedule('*/30 * * * * *', () => {
      tasks([
        { failure: '[notifier] Retry worker failed:', run: () => options.engine.processDue() },
        ...(options.retryTasks ?? []),
      ])
    })
    purgeTask = cron.schedule('0 3 * * *', () => {
      tasks([
        { failure: '[notifier] Delivery history purge failed:', run: () => options.engine.purgeOldDeliveries() },
        ...(options.purgeTasks ?? []),
      ])
    })
    console.log(`${options.logPrefix ?? '[notifier]'} Retry worker started`)
  }

  function stop(): void {
    retryTask?.destroy()
    purgeTask?.destroy()
    retryTask = null
    purgeTask = null
  }

  return { start, stop }
}
