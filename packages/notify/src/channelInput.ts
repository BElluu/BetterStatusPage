import type { NotificationChannelType } from '@better-kit/contracts'
import { placeholderInAuthority } from './template.js'

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
  const overridesProblem = eventOverridesError(type, config)
  if (overridesProblem) return overridesProblem
  if (type === 'telegram') return telegramConfigError(config)
  if (type === 'ntfy') return ntfyConfigError(config)
  if (type === 'pushover') return pushoverConfigError(config)
  if (type === 'webhook') {
    const url = asConfig(config)['url']
    if (typeof url === 'string' && placeholderInAuthority(url)) return 'A placeholder cannot be part of the host of the URL'
  }
  return null
}

/**
 * The fields of a channel that word a message, per type. A channel may carry its own wording for one kind of event
 * (`eventOverrides`, keyed by the event type) made of these fields only; the destination and the credentials always
 * come from the channel itself, so an override can never send a message somewhere else.
 */
export const TEMPLATE_KEYS: Record<NotificationChannelType, readonly string[]> = {
  email: ['subject', 'body'],
  webhook: ['body'],
  discord: ['content'],
  teams: ['summary'],
  slack: ['text'],
  telegram: ['text'],
  ntfy: ['text'],
  pushover: ['text'],
}

const MAX_OVERRIDE_TEXT = 10_000
const MAX_OVERRIDE_EVENTS = 8
const EVENT_KEY = /^[a-z_]{1,32}$/

/** What is wrong with the `eventOverrides` of a channel's config, or null. */
export function eventOverridesError(type: string, config: unknown): string | null {
  const overrides = asConfig(config)['eventOverrides']
  if (overrides === undefined) return null
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return 'eventOverrides must be an object'
  const events = Object.entries(overrides)
  if (events.length > MAX_OVERRIDE_EVENTS) return `eventOverrides can hold at most ${MAX_OVERRIDE_EVENTS} events`
  const allowed = TEMPLATE_KEYS[type as NotificationChannelType] ?? []
  for (const [event, fields] of events) {
    if (!EVENT_KEY.test(event) || event in Object.prototype || event === 'prototype') return `eventOverrides has an invalid event name "${event}"`
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return `eventOverrides.${event} must be an object`
    for (const [field, value] of Object.entries(fields)) {
      if (!allowed.includes(field)) return `eventOverrides.${event}.${field} is not a message field of a ${type} channel (${allowed.join(', ')})`
      if (typeof value !== 'string' || value.length > MAX_OVERRIDE_TEXT) return `eventOverrides.${event}.${field} must be text of up to ${MAX_OVERRIDE_TEXT} characters`
    }
  }
  return null
}

/** The wording a kind of event has when its channel has none of its own: by channel type, then message field. */
export type DefaultWording = Record<string, Partial<Record<string, Record<string, string>>>>

/** How a channel words each kind of event: its own message fields for `ownEvents`, its override or the default for any other. */
export interface EventWording {
  ownEvents: readonly string[]
  defaults?: DefaultWording
}

/**
 * The config a message of the given kind of event is sent with. The channel's own message fields word the kinds in
 * `wording.ownEvents`. Any other kind is worded by what the channel has for it (`eventOverrides`), and by the default
 * for the fields it has nothing for, never by the channel's own fields, which were written for something else. A field
 * left without wording is sent in the channel's standard form. Without `wording`, every kind uses the channel's own
 * fields and an override only replaces some of them.
 */
export function configForEvent(type: string, config: Record<string, unknown>, event: string | undefined, wording?: EventWording): Record<string, unknown> {
  const keys = TEMPLATE_KEYS[type as NotificationChannelType] ?? []
  const own = !wording || event === undefined || wording.ownEvents.includes(event)
  const all = config['eventOverrides'] as Record<string, Record<string, unknown>> | undefined
  const overrides = event && all && typeof all === 'object' && Object.hasOwn(all, event) ? all[event] : undefined
  const fields = overrides && typeof overrides === 'object' ? overrides : {}
  const defaults = own ? {} : wording.defaults?.[event!]?.[type] ?? {}
  if (own && !overrides) return config

  const merged = { ...config }
  for (const key of keys) {
    if (!own) delete merged[key]
    const text = fields[key] !== undefined && fields[key] !== '' ? fields[key] : defaults[key]
    if (typeof text === 'string' && text !== '') merged[key] = text
  }
  // A request without a body cannot carry one, and the form drops it too.
  if (type === 'webhook' && /^(GET|HEAD)$/i.test(String(merged['method'] ?? 'POST'))) delete merged['body']
  return merged
}
