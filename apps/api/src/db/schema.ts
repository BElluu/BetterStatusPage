// Every table of the application, by the module that owns it (see ./modules).
export { apiTokens, authSessions, oidcSettings, users } from '@better-kit/auth'
export { auditLog } from '@better-kit/audit'
export { vaults, vaultSecrets } from '@better-kit/vault'
import { notifyModule } from './modules/notify/index.js'

export const { notificationChannels, notificationDeliveryAttempts, smtpSettings } = notifyModule.tables
export { notificationDeliveries } from './modules/notify/tables.js'
export * from './modules/app/tables.js'
