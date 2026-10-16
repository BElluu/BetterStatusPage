import { createNotifyDbModule } from '@better-kit/notify'
import { randomEntityKey } from '@better-kit/config-as-code'

/** Notification channels, their delivery history and SMTP settings. */
export const notifyModule = createNotifyDbModule({
  sourceIdColumn: 'monitor_id',
  sourceNameColumn: 'monitor_name',
  smtpFromName: 'BSP Alerts',
  newKey: randomEntityKey,
})
