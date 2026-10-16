import { eq } from 'drizzle-orm'
import { tokenAllows } from '@better-kit/contracts'
import { createNotifyRoutes } from '@better-kit/notify'
import { db } from '../db/client.js'
import { notifyModule } from '../db/modules/notify/index.js'
import { actionFailureChannels, monitorNotificationChannels } from '../db/schema.js'
import { keyForNew } from '@better-kit/config-as-code'
import { requestIdentity } from '../middleware/auth.js'
import { maskSecrets, restoreSecrets } from '../services/secretFields.js'
import { notifyEngine } from './notify.js'
import { testNotificationChannel, testSmtp } from '../workers/notifier.js'
import { audit } from './audit.js'
import { vaultUseGuard } from './vault.js'

/** The admin routes of the notifications (history, channels, SMTP). The links to monitors are added in routes/notifications.ts. */
export const notifyRoutes = createNotifyRoutes({
  db,
  tables: notifyModule.tables,
  audit,
  identity: requestIdentity,
  // The grouping setting has always been stored and sent as `minMonitors`.
  minSourcesKey: 'minMonitors',
  wire: { sourceId: 'monitorId', sourceName: 'monitorName', sourcePlural: 'monitors' },
  defaultFromName: 'BSP Alerts',
  // The history of a failed action names the action and quotes what its target answered, so it is for those who may
  // read actions (administrators, or a token with actions:read), not for every operator who may read the history.
  hiddenEventTypes: (req) => {
    const identity = requestIdentity(req)
    const mayReadActions = identity.apiToken ? tokenAllows(identity.apiToken.scopes, 'actions:read') : identity.role === 'admin'
    return mayReadActions ? [] : ['action']
  },
  secrets: {
    mask: (config) => maskSecrets('channel', config),
    restore: (incoming, stored) => restoreSecrets('channel', incoming, stored),
  },
  vaultUse: { refused: vaultUseGuard.refused, problem: vaultUseGuard.vaultUseProblem },
  resolveKey: keyForNew,
  onChannelDeleted: async (channelId) => {
    await db.delete(monitorNotificationChannels).where(eq(monitorNotificationChannels.channelId, channelId))
    await db.delete(actionFailureChannels).where(eq(actionFailureChannels.channelId, channelId))
  },
  retryDelivery: (deliveryId) => notifyEngine.retryDelivery(deliveryId),
  testChannel: (channelId) => testNotificationChannel(channelId),
  testSmtp: (to) => testSmtp(to),
})
