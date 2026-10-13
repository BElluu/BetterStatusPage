import type { NotificationChannelType } from '@bsp/shared'

export const CHANNEL_TYPES: readonly NotificationChannelType[] = ['email', 'webhook', 'discord', 'teams', 'slack', 'telegram', 'ntfy', 'pushover']

type TokenConfig = { vault?: { vaultId?: unknown; secretId?: unknown }; [key: string]: unknown }

function asConfig(config: unknown): TokenConfig {
  return (config && typeof config === 'object' ? config : {}) as TokenConfig
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/**
 * A credential is a vault reference or a direct token; an edited mask is not a token. A missing one is reported
 * as `missing`, or accepted when `missing` is null (a public ntfy topic needs none).
 */
function credentialError(c: TokenConfig, key: string, label: string, missing: string | null): string | null {
  if (c.vault) return Number.isInteger(c.vault.vaultId) && Number.isInteger(c.vault.secretId) && Number(c.vault.secretId) > 0 ? null : `Pick a vault secret for the ${label}`
  const token = c[key]
  if (token === undefined || token === null || token === '') return missing
  if (typeof token !== 'string') return `The ${label} must be text`
  if (!token.trim()) return missing
  return token.includes('•') ? `Paste the full ${label} to replace the stored one` : null
}

/** Telegram needs a chat and a token, direct or from the vault; an edited mask is not a token. */
export function telegramConfigError(config: unknown): string | null {
  const c = asConfig(config)
  if (!isText(c['chatId'])) return 'Telegram needs a Chat ID'
  return credentialError(c, 'botToken', 'bot token', 'Telegram needs a Bot Token')
}

const NTFY_TOPIC = /^[A-Za-z0-9_-]{1,64}$/

/** ntfy needs a topic; the server defaults to ntfy.sh and the access token is optional. */
export function ntfyConfigError(config: unknown): string | null {
  const c = asConfig(config)
  if (!isText(c['topic']) || !NTFY_TOPIC.test(c['topic'].trim())) return 'ntfy needs a topic of up to 64 letters, digits, "-" or "_"'
  const server = c['serverUrl']
  if (server !== undefined && server !== null && server !== '') {
    if (typeof server !== 'string') return 'Server URL must be text'
    let url: URL
    try {
      url = new URL(server)
    } catch {
      return 'Server URL is not a valid URL'
    }
    if (!/^https?:$/.test(url.protocol)) return 'Server URL must start with http:// or https://'
    // The URL is not a masked field, so it must not carry a login, and a query would end up in the middle of the publish URL.
    if (url.username || url.password || url.search || url.hash) return 'Server URL must not contain a login, query or fragment'
  }
  const problem = credentialError(c, 'accessToken', 'access token', null)
  if (problem) return problem
  // A token goes into a header; a character that cannot be sent there makes every delivery fail.
  return typeof c['accessToken'] === 'string' && c['accessToken'] && !c.vault && !/^[\x21-\x7e•]+$/.test(c['accessToken']) ? 'The access token contains characters that cannot be sent in a header' : null
}

/** Pushover needs a user or group key and an application token, direct or from the vault. */
export function pushoverConfigError(config: unknown): string | null {
  const c = asConfig(config)
  if (!isText(c['userKey'])) return 'Pushover needs a User Key'
  return credentialError(c, 'appToken', 'application token', 'Pushover needs an Application Token')
}

/** The first problem with a channel's config that depends on its type, or null. */
export function channelConfigError(type: string, config: unknown): string | null {
  if (type === 'telegram') return telegramConfigError(config)
  if (type === 'ntfy') return ntfyConfigError(config)
  if (type === 'pushover') return pushoverConfigError(config)
  return null
}
