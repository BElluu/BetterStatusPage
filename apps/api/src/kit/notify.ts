import { createNotifyEngine, createTransports } from '@better-forge/notify'
import { DEFAULT_EMAIL_BODY, DEFAULT_EMAIL_SUBJECT } from '@bsp/shared'
import { db } from '../db/client.js'
import { notifyModule } from '../db/modules/notify/index.js'
import { digestOf, noticeFromVars } from '../workers/notice.js'
import { resolveVaultSecret } from './resolveSecret.js'

// Discord only accepts a public image URL for a webhook avatar; it cannot be uploaded as a file.
const DISCORD_AVATAR_URL = 'https://docs.betterstatuspage.dev/discord-avatar.png'

/** Delivery queue, alert hygiene, retries and SMTP of this application. */
export const notifyEngine = createNotifyEngine({
  db,
  tables: notifyModule.tables,
  minSourcesKey: 'minMonitors',
  events: { alert: 'alert', recovery: 'recovery', ungrouped: 'action' },
  deliver: (channel, vars) => transports.deliver(channel, vars, noticeFromVars(vars)),
  digest: digestOf,
  resolveSecret: resolveVaultSecret,
})

/** The channel senders (email, webhook, Discord, Teams, Slack, Telegram, ntfy, Pushover). */
export const transports = createTransports({
  resolveSecret: resolveVaultSecret,
  sendMail: (message) => notifyEngine.sendSmtpMail(message),
  discordAvatarUrl: DISCORD_AVATAR_URL,
  standardEmail: { subject: DEFAULT_EMAIL_SUBJECT, body: DEFAULT_EMAIL_BODY },
  // What a channel's own message fields say is about monitors. An action has its own wording (the Action tab of the
  // channel form), and without it a webhook gets this, while the other channels use their standard message.
  wording: {
    ownEvents: ['alert', 'recovery', 'certificate', 'latency', 'test'],
    defaults: {
      action: {
        webhook: {
          body: `{
  "action": "{{action_name}}",
  "monitor": "{{monitor_name}}",
  "status": "{{status}}",
  "trigger_status": "{{trigger_status}}",
  "attempts": "{{attempts}}",
  "error": "{{error_message}}",
  "time": "{{checked_at}}"
}`,
        },
      },
    },
  },
})
