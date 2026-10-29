import { createAudit } from '@better-forge/audit'
import { createAuth, createRoleRegistry, createTokenCatalogue, requestIdentity, type Auth } from '@better-forge/auth'
import {
  createBackupRoutes, createBackupRunner, createBackupScheduler, createBackupService, createRestore, type BackupManifest,
} from '@better-forge/backup'
import { keyForNew } from '@better-forge/config-as-code'
import {
  CHANNEL_DESTINATIONS, CHANNEL_SECRETS, createDeliveryWorker, createNotifyEngine, createNotifyRoutes, createTransports, type Notice,
} from '@better-forge/notify'
import {
  createAppLock, createPublicUrlResolver, currentProcessOwner, dataDir, databasePath, backupDir, isOwnerAlive,
} from '@better-forge/runtime'
import { createSecretFields, createVault, createVaultUseGuard, uniqueSecretFields } from '@better-forge/vault'
import { EXTRA_SCOPES, TOKEN_RESOURCES } from '../shared/tokens.js'
import { closeDb, db, initDb, migrate, notifyModule, sqlite } from './db.js'

const NAME = 'Better Template'
const VERSION = '0.1.0'

/** The audit log of the application. */
export const audit = createAudit({ db })

/** Vaults and secrets. */
export const vault = createVault({ db, audit, identity: requestIdentity })

/** Besides the administrator there is one role. */
export const roles = createRoleRegistry()
roles.register(['member'], { fallback: 'member', defaultForNewUsers: 'member' })

export const tokenCatalogue = createTokenCatalogue({ resources: TOKEN_RESOURCES, extraScopes: EXTRA_SCOPES })

/** The address the application is reached at (the PUBLIC_URL environment variable). */
export const resolvePublicUrl = createPublicUrlResolver()

/** Accounts, sessions, single sign-on and API tokens. */
export const auth: Auth = createAuth({
  db,
  sqlite,
  audit,
  roles,
  tokens: tokenCatalogue,
  secretBox: vault.secretBox,
  cookies: { session: 'tpl_session', csrf: 'tpl_csrf', oidcFlow: 'tpl_oidc_flow', twoFactorChallenge: 'tpl_2fa_challenge' },
  apiTokenPrefix: 'tpl_',
  totpIssuer: NAME,
  basePath: '/api/v1/auth',
  urls: { signIn: '/login', home: '/', ssoConfirm: '/sso-confirm', ssoTest: '/sso-test' },
  publicUrl: resolvePublicUrl,
  secureCookies: () => process.env['NODE_ENV'] === 'production',
  rateLimits: {
    signIn: { groupId: 'auth-login', max: 10, timeWindow: '15 minutes' },
    sensitiveAction: { groupId: 'sensitive-action', max: 5, timeWindow: '15 minutes' },
  },
})

export const { requireAuth, requireRole } = auth.middleware
export const vaultUseGuard = createVaultUseGuard({ target: 'channel' })

// ── Notifications ─────────────────────────────────────────────────────────────

/** What the channels say about an event: the template's events carry a title, a status and a message. */
function noticeFromVars(vars: Record<string, string>): Notice {
  const status = vars['status'] ?? 'unknown'
  return {
    severity: status === 'ok' ? 'ok' : status === 'warning' ? 'warning' : 'critical',
    headline: [vars['title'] ?? 'Notification'],
    subtitle: [],
    facts: [{ label: 'Status', value: status }],
    ...(vars['message'] ? { detail: { label: 'Message', value: vars['message'] } } : {}),
    at: vars['at'] ?? new Date().toISOString(),
    atLabel: 'At',
  }
}

export const notifyEngine = createNotifyEngine({
  db,
  tables: notifyModule.tables,
  minSourcesKey: 'minSources',
  events: { alert: 'alert', recovery: 'recovery', ungrouped: 'test' },
  deliver: (channel, vars) => transports.deliver(channel, vars, noticeFromVars(vars)),
  digest: (rows, now) => ({
    sourceName: `${rows.length} sources`,
    vars: { title: `${rows.length} notifications`, status: 'critical', message: rows.map((row) => row.sourceName).join(', '), at: new Date(now).toISOString() },
  }),
  resolveSecret: (ref) => vault.resolver.resolveVaultSecret(ref),
})

export const transports = createTransports({
  resolveSecret: (ref) => vault.resolver.resolveVaultSecret(ref),
  sendMail: (message) => notifyEngine.sendSmtpMail(message),
  discordAvatarUrl: 'https://example.invalid/avatar.png',
})

const secretFields = createSecretFields<'channel'>({
  channel: { fields: uniqueSecretFields(Object.values(CHANNEL_SECRETS).flat()), destinations: CHANNEL_DESTINATIONS },
})

export const notifyRoutes = createNotifyRoutes({
  db,
  tables: notifyModule.tables,
  audit,
  identity: requestIdentity,
  minSourcesKey: 'minSources',
  wire: { sourceId: 'sourceId', sourceName: 'sourceName', sourcePlural: 'sources' },
  defaultFromName: 'Template Alerts',
  hiddenEventTypes: () => [],
  secrets: {
    mask: (config) => secretFields.maskSecrets('channel', config),
    restore: (incoming, stored) => secretFields.restoreSecrets('channel', incoming, stored),
  },
  vaultUse: { refused: vaultUseGuard.refused, problem: vaultUseGuard.vaultUseProblem },
  resolveKey: keyForNew,
  onChannelDeleted: async () => undefined,
  retryDelivery: (id) => notifyEngine.retryDelivery(id),
  testChannel: async (channelId) => {
    const channel = (await db.select().from(notifyModule.tables.notificationChannels)).find((row) => row.id === channelId)
    if (!channel) return { ok: false, error: 'Channel not found' }
    return notifyEngine.sendDirect(channel, { title: 'Test notification', status: 'ok', message: 'This is a test notification' }, { sourceId: null, sourceName: 'Test', eventType: 'test' })
  },
  testSmtp: async (to) => {
    try {
      await notifyEngine.sendSmtpMail({ to, subject: 'SMTP test', text: 'If you received this, your SMTP configuration works.' })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  },
})

/** Sends due notifications every 30 seconds and purges the history daily. */
export const deliveryWorker = createDeliveryWorker({ engine: notifyEngine })

// ── Backups ───────────────────────────────────────────────────────────────────

export const backup = createBackupService<BackupManifest>({
  name: 'template',
  magic: 'KITTPL01',
  formatVersion: 1,
  backupDir,
  databasePath,
  appVersion: () => VERSION,
  processOwner: { current: currentProcessOwner, isAlive: isOwnerAlive },
  extras: () => ({ entries: [], manifest: {} }),
})

// The template has no worker script of its own, so backups run in the calling thread.
export const backupRunner = createBackupRunner<BackupManifest>({
  service: backup,
  inline: true,
  workerUrl: new URL('file:///unused.js'),
  moduleUrl: 'file:///unused.js',
})

export const backupScheduler = createBackupScheduler({
  readConfig: backup.readBackupConfig,
  run: async (config) => {
    await backupRunner.createBackup()
    backup.applyRetention(config.retention)
  },
})

export const backupRoutes = createBackupRoutes<BackupManifest>({
  service: backup,
  audit,
  identity: requestIdentity,
  createBackup: () => backupRunner.createBackup(),
  validateBackup: (input) => backupRunner.validateBackup(input),
  restartScheduler: backupScheduler.restart,
})

/** Restores a backup over the stopped application. */
export const restoreBackup = createRestore<BackupManifest>({
  service: backup,
  name: 'template',
  displayName: NAME,
  databasePath,
  assertStopped: () => undefined,
  database: { open: initDb, close: closeDb, migrate },
  extras: () => ({ save: () => undefined, apply: () => undefined, rollback: () => undefined }),
})

/** Marks the data directory as in use by a running instance. */
export const appLock = createAppLock({ name: NAME, fileName: '.template-running', dir: () => dataDir() })

/** Background work that runs once the application is set up. */
export const backgroundServices = {
  start() {
    deliveryWorker.start()
    backupScheduler.restart()
  },
  stop() {
    deliveryWorker.stop()
    backupScheduler.stop()
  },
}
