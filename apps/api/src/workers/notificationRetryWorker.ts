import cron, { type ScheduledTask } from 'node-cron'
import { processDueNotificationDeliveries, purgeOldNotificationDeliveries } from './notifier.js'

let task: ScheduledTask | null = null

export function startNotificationRetryWorker(): void {
  if (task) return
  task = cron.schedule('*/30 * * * * *', () => {
    processDueNotificationDeliveries().catch((error) => console.error('[notifier] Retry worker failed:', error))
  })
  cron.schedule('0 3 * * *', () => {
    purgeOldNotificationDeliveries().catch((error) => console.error('[notifier] Delivery history purge failed:', error))
  })
  console.log('[notifier] Retry worker started')
}
