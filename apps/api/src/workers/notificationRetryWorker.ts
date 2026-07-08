import cron, { type ScheduledTask } from 'node-cron'
import { processDueNotificationDeliveries, purgeOldNotificationDeliveries } from './notifier.js'

let retryTask: ScheduledTask | null = null
let purgeTask: ScheduledTask | null = null

export function startNotificationRetryWorker(): void {
  if (retryTask || purgeTask) return
  retryTask = cron.schedule('*/30 * * * * *', () => {
    processDueNotificationDeliveries().catch((error) => console.error('[notifier] Retry worker failed:', error))
  })
  purgeTask = cron.schedule('0 3 * * *', () => {
    purgeOldNotificationDeliveries().catch((error) => console.error('[notifier] Delivery history purge failed:', error))
  })
  console.log('[notifier] Retry worker started')
}

export function stopNotificationRetryWorker(): void {
  retryTask?.destroy()
  purgeTask?.destroy()
  retryTask = null
  purgeTask = null
}
