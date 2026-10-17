import type { SecretField } from '@better-kit/vault'

/** Which parts of a channel's configuration are secrets, by channel type. */
const WEBHOOK_URL_SECRET: readonly SecretField[] = [{ path: ['webhookUrl'] }]

export const CHANNEL_SECRETS: Readonly<Record<string, readonly SecretField[]>> = {
  webhook: [{ mapAt: ['headers'] }],
  slack: WEBHOOK_URL_SECRET,
  discord: WEBHOOK_URL_SECRET,
  teams: WEBHOOK_URL_SECRET,
  telegram: [{ path: ['botToken'], tail: true }],
  ntfy: [{ path: ['accessToken'], tail: true }],
  pushover: [{ path: ['appToken'], tail: true }],
}

/**
 * Where a channel's secret ends up. Keeping a stored secret while this changes would let whoever edits the channel
 * send it to a host of their choosing, so the secret must be entered again.
 */
export const CHANNEL_DESTINATIONS: readonly (readonly string[])[] = [['url'], ['serverUrl']]
