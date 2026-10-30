import { createNotifyDbModule } from '@better-forge/notify'
import { randomEntityKey } from '@better-forge/config-as-code'
import { notifySealedColumns } from '../../../services/sealedColumns.js'

/** Notification channels, their delivery history and SMTP settings. */
export const notifyModule = createNotifyDbModule({
  sourceIdColumn: 'monitor_id',
  sourceNameColumn: 'monitor_name',
  smtpFromName: 'BSP Alerts',
  newKey: randomEntityKey,
  sealed: notifySealedColumns,
})
