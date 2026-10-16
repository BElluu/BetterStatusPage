import { createDeliveryWorker } from '@better-kit/notify'
import { notifyEngine } from '../kit/notify.js'
import { processDueSubscriberDeliveries, purgeSubscriberData } from './subscriberNotifier.js'
import { processDueActionRuns, purgeOldActionRuns } from './actionRunner.js'

/** Sends due notifications, and on the same ticks the subscriber mails and action runs of this application. */
const worker = createDeliveryWorker({
  engine: notifyEngine,
  retryTasks: [
    { failure: '[subscriptions] Retry worker failed:', run: () => processDueSubscriberDeliveries() },
    { failure: '[actions] Run worker failed:', run: () => processDueActionRuns() },
  ],
  purgeTasks: [
    { failure: '[subscriptions] Purge failed:', run: () => purgeSubscriberData() },
    { failure: '[actions] Run history purge failed:', run: () => purgeOldActionRuns() },
  ],
})

export const startNotificationRetryWorker = worker.start
export const stopNotificationRetryWorker = worker.stop
