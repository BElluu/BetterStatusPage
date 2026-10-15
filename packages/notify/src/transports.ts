import type { VaultRef } from '@better-kit/contracts'
import { plainSegments, readableTimestamp, renderSegments, type Notice, type NoticeSeverity } from './notice.js'
import type { SmtpMessage } from './engine.js'
import { buildWebhookRequest, substituteVars } from './template.js'

export interface TransportOptions {
  /** Resolves a vault reference to its secret fields (channel credentials may be kept in a vault). */
  resolveSecret: (ref: VaultRef) => Promise<Record<string, string>>
  /** Sends one mail through the application's SMTP settings. */
  sendMail: (message: SmtpMessage) => Promise<void>
  /** Discord only accepts a public image URL for a webhook avatar; it cannot be uploaded as a file. */
  discordAvatarUrl: string
}

/** The part of a stored channel that picks and configures its transport. */
export interface TransportChannel {
  type: string
  /** JSON configuration of the channel. */
  config: string
}

const OUTBOUND_TIMEOUT_MS = 15_000

const SEVERITY_EMOJI: Record<NoticeSeverity, string> = { critical: '🔴', warning: '🟡', ok: '🟢' }

const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Cuts `value` to `max` characters without splitting a surrogate pair. */
function clip(value: string, max: number): string {
  const chars = Array.from(value)
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`
}

/** Cuts `value` to `maxBytes` of UTF-8 without splitting a character. */
function clipBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  let out = ''
  for (const char of value) {
    if (Buffer.byteLength(out + char + '…') > maxBytes) break
    out += char
  }
  return `${out}…`
}

/** One outbound notification request; a non-2xx answer fails the delivery as `<failurePrefix> <status>`. */
async function sendHttp(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  failurePrefix: string,
): Promise<void> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${failurePrefix} ${res.status}`)
}

function postWebhookJson(url: string, payload: unknown, label: string): Promise<void> {
  return sendHttp(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, `${label} webhook returned HTTP`)
}

/** Throws `<service> API returned HTTP <status>[: <reason>]`; the reason is the service's own error text, never a credential. */
async function failOnHttpError(res: Response, service: string, reason: (json: Record<string, unknown>) => string): Promise<void> {
  if (res.ok) return
  const text = await res.json().then((j: unknown) => (j && typeof j === 'object' && !Array.isArray(j) ? reason(j as Record<string, unknown>) : '')).catch(() => '')
  throw new Error(`${service} API returned HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
}

const TELEGRAM_MAX_LENGTH = 4096
/** Keeps the optional Message Text from crowding out the facts; the detail field is what gets cut to fit. */
const TELEGRAM_MAX_TEXT_LINE = 1000

const NTFY_DEFAULT_SERVER = 'https://ntfy.sh'
/** ntfy's default message limit is 4096 bytes, not characters. */
const NTFY_MAX_MESSAGE_BYTES = 4000
const HEADER_SAFE_TOKEN = /^[\x21-\x7e]+$/
const NTFY_PRIORITY: Record<NoticeSeverity, number> = { critical: 4, warning: 3, ok: 3 }
const NTFY_TAGS: Record<NoticeSeverity, string> = { critical: 'rotating_light', warning: 'warning', ok: 'white_check_mark' }

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json'
const PUSHOVER_MAX_MESSAGE = 1024
/** Pushover priority 1 is high: it bypasses the recipient's quiet hours. Only a critical event gets it. */
const PUSHOVER_PRIORITY: Record<NoticeSeverity, number> = { critical: 1, warning: 0, ok: 0 }

const DISCORD_COLORS: Record<NoticeSeverity, number> = { critical: 0xe53935, warning: 0xfb8c00, ok: 0x43a047 }
const TEAMS_COLORS: Record<NoticeSeverity, string> = { critical: 'E53935', warning: 'FB8C00', ok: '43A047' }
const SLACK_COLORS: Record<NoticeSeverity, string> = { critical: '#E53935', warning: '#FB8C00', ok: '#43A047' }

interface TelegramConfig { botToken?: string; vault?: VaultRef; chatId: string; text?: string }
interface NtfyConfig { serverUrl?: string; topic: string; accessToken?: string; vault?: VaultRef; text?: string }
interface PushoverConfig { appToken?: string; vault?: VaultRef; userKey: string; text?: string }

type Vars = Record<string, string>

/**
 * The channel senders. An email and a webhook are written by the user as templates over `vars`; the other channels
 * format the `notice` themselves and only read `vars` to fill in the free text the user typed into the channel.
 */
export function createTransports(options: TransportOptions) {
  /** A credential typed into the channel, or the `value` secret of its vault reference. */
  async function resolveToken(direct: string | undefined, vault: VaultRef | undefined, vaultProblem: string): Promise<string> {
    if (!vault) return direct ?? ''
    const secret = await options.resolveSecret(vault)
    const token = (secret['value'] ?? '').trim()
    if (!token) throw new Error(vaultProblem)
    return token
  }

  async function sendEmail(config: { to: string; subject: string; body: string }, vars: Vars) {
    await options.sendMail({
      to: substituteVars(config.to, vars),
      subject: substituteVars(config.subject, vars),
      text: substituteVars(config.body, vars),
    })
  }

  async function sendWebhook(config: { url: string; method: string; headers?: Record<string, string>; body?: string }, vars: Vars) {
    const { url, init } = buildWebhookRequest(config, vars)
    await sendHttp(url, init, 'HTTP')
  }

  async function sendDiscord(
    config: { webhookUrl: string; username?: string; avatarUrl?: string; content?: string },
    vars: Vars,
    notice: Notice,
  ) {
    const embed = {
      title: renderSegments(notice.headline, { subject: (v) => `\`${v}\``, state: (v) => `**${v}**` }),
      color: DISCORD_COLORS[notice.severity],
      fields: [
        ...notice.facts.map(({ label, value }) => ({ name: label, value, inline: true })),
        ...(notice.detail ? [{ name: notice.detail.label, value: notice.detail.value, inline: false }] : []),
      ],
      footer: { text: `${notice.atLabel} ${notice.at}` },
      timestamp: new Date().toISOString(),
    }

    const payload: Record<string, unknown> = { embeds: [embed] }
    if (config.username) payload['username'] = config.username
    payload['avatar_url'] = config.avatarUrl ? substituteVars(config.avatarUrl, vars) : options.discordAvatarUrl
    if (config.content) payload['content'] = substituteVars(config.content, vars)

    await postWebhookJson(config.webhookUrl, payload, 'Discord')
  }

  async function sendTeams(config: { webhookUrl: string; summary?: string }, vars: Vars, notice: Notice) {
    // The card title is led by the emoji and the bold subject; the kind of subject is left to the summary.
    const bold = { kind: () => '', subject: (v: string) => `**${v}**`, state: (v: string) => `**${v}**` }
    const summary = config.summary ? substituteVars(config.summary, vars) : plainSegments(notice.headline)

    const facts: { name: string; value: string }[] = [
      ...notice.facts.map((fact) => ({ name: fact.fullLabel ?? fact.label, value: fact.value })),
      ...(notice.detail ? [{ name: notice.detail.label, value: notice.detail.value }] : []),
      { name: notice.atLabel, value: notice.at },
    ]

    const payload = {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      themeColor: TEAMS_COLORS[notice.severity],
      summary,
      sections: [{
        activityTitle: `${SEVERITY_EMOJI[notice.severity]} ${renderSegments(notice.headline, bold)}`,
        activitySubtitle: renderSegments(notice.subtitle, bold),
        facts,
        markdown: true,
      }],
    }

    await postWebhookJson(config.webhookUrl, payload, 'Teams')
  }

  async function sendSlack(config: { webhookUrl: string; text?: string }, vars: Vars, notice: Notice) {
    const headline = renderSegments(notice.headline, { subject: (v) => `*${v}*`, state: (v) => `*${v}*` })
    const fallbackText = `${SEVERITY_EMOJI[notice.severity]} ${headline}`

    const fields = [
      ...notice.facts.map(({ label, value }) => ({ type: 'mrkdwn', text: `*${label}:*\n${value}` })),
      ...(notice.detail ? [{ type: 'mrkdwn', text: `*${notice.detail.label}:*\n${notice.detail.value}` }] : []),
    ]

    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: fallbackText } },
      { type: 'section', fields },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${notice.atLabel} ${notice.at}` }] },
    ]

    const payload: Record<string, unknown> = {
      text: fallbackText,
      attachments: [{ color: SLACK_COLORS[notice.severity], blocks }],
    }
    if (config.text) payload['text'] = substituteVars(config.text, vars) + '\n' + fallbackText

    await postWebhookJson(config.webhookUrl, payload, 'Slack')
  }

  async function sendTelegram(config: TelegramConfig, vars: Vars, notice: Notice) {
    const botToken = await resolveToken(config.botToken, config.vault, 'Telegram vault secret has no bot token: use a value secret')
    const headline = renderSegments(notice.headline, { text: escapeHtml, subject: (v) => `<b>${v}</b>`, state: (v) => `<b>${v}</b>` })

    const detail = notice.detail ? escapeHtml(notice.detail.value) : ''
    const build = (detailText: string) => [
      ...(config.text ? [escapeHtml(Array.from(substituteVars(config.text, vars)).slice(0, TELEGRAM_MAX_TEXT_LINE).join(''))] : []),
      `${SEVERITY_EMOJI[notice.severity]} ${headline}`,
      '',
      ...notice.facts.map(({ label, value }) => `<b>${label}:</b> ${escapeHtml(value)}`),
      ...(detailText ? [`<b>${notice.detail!.label}:</b> ${detailText}`] : []),
      `<i>${notice.atLabel} ${escapeHtml(readableTimestamp(notice.at))}</i>`,
    ].join('\n')

    // Cutting the finished message could split an HTML tag, so an oversized one loses the tail of the details field only.
    let text = build(detail)
    if (text.length > TELEGRAM_MAX_LENGTH && detail) {
      const keep = Math.max(0, detail.length - (text.length - TELEGRAM_MAX_LENGTH) - 1)
      text = build(`${detail.slice(0, keep).replace(/&[a-z]*$/, '')}…`)
    }

    // The bot token is part of the URL path. Only the status code and Telegram's own description are reported
    // (the Bot API never echoes the token), so the token never reaches the delivery history.
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId.trim().replace(/^#(?=-?\d)/, ''), text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    })
    await failOnHttpError(res, 'Telegram', (j) => typeof j['description'] === 'string' ? j['description'] : '')
  }

  /** The plain-text alert the push channels (ntfy, Pushover) show: a headline and the facts under it. */
  function plainAlert(notice: Notice, vars: Vars, customText: string | undefined, maxBody: number): { title: string; body: string } {
    const body = [
      ...(customText ? [clip(substituteVars(customText, vars), TELEGRAM_MAX_TEXT_LINE)] : []),
      ...notice.facts.map(({ label, value }) => `${label}: ${value}`),
      ...(notice.detail ? [`${notice.detail.label}: ${notice.detail.value}`] : []),
      `${notice.atLabel} ${readableTimestamp(notice.at)}`,
    ].join('\n')
    return { title: clip(plainSegments(notice.headline), 250), body: clip(body, maxBody) }
  }

  async function sendNtfy(config: NtfyConfig, vars: Vars, notice: Notice) {
    const token = await resolveToken(config.accessToken, config.vault, 'ntfy vault secret has no access token: use a value secret')
    // fetch quotes an invalid header value in its error, which would put the token into the delivery history.
    if (token && !HEADER_SAFE_TOKEN.test(token)) throw new Error('ntfy access token contains characters that cannot be sent in a header')
    const { title, body } = plainAlert(notice, vars, config.text, NTFY_MAX_MESSAGE_BYTES)
    // A server behind a reverse proxy may live under a path prefix, which publishing keeps.
    const target = new URL(config.serverUrl?.trim() || NTFY_DEFAULT_SERVER)
    if (!target.pathname.endsWith('/')) target.pathname += '/'
    // Publishing as JSON to the server root keeps non-ASCII titles intact, which a header-based publish would not.
    const res = await fetch(target.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ topic: config.topic.trim(), title, message: clipBytes(body, NTFY_MAX_MESSAGE_BYTES), priority: NTFY_PRIORITY[notice.severity], tags: [NTFY_TAGS[notice.severity]] }),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      redirect: 'error',
    })
    await failOnHttpError(res, 'ntfy', (j) => typeof j['error'] === 'string' ? j['error'] : '')
  }

  async function sendPushover(config: PushoverConfig, vars: Vars, notice: Notice) {
    const token = await resolveToken(config.appToken, config.vault, 'Pushover vault secret has no application token: use a value secret')
    const { title, body } = plainAlert(notice, vars, config.text, PUSHOVER_MAX_MESSAGE)
    const res = await fetch(PUSHOVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, user: config.userKey.trim(), title, message: body, priority: PUSHOVER_PRIORITY[notice.severity] }),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      redirect: 'error',
    })
    await failOnHttpError(res, 'Pushover', (j) => Array.isArray(j['errors']) ? j['errors'].filter((e) => typeof e === 'string').join('; ') : '')
  }

  /** Sends one event through the channel; throws when the channel type is unknown or the send fails. */
  async function deliver(channel: TransportChannel, vars: Vars, notice: Notice): Promise<void> {
    const config = JSON.parse(channel.config) as Record<string, unknown>
    switch (channel.type) {
      case 'email': return sendEmail(config as { to: string; subject: string; body: string }, vars)
      case 'webhook': return sendWebhook(config as { url: string; method: string; headers?: Record<string, string>; body?: string }, vars)
      case 'discord': return sendDiscord(config as { webhookUrl: string; username?: string; avatarUrl?: string; content?: string }, vars, notice)
      case 'teams': return sendTeams(config as { webhookUrl: string; summary?: string }, vars, notice)
      case 'slack': return sendSlack(config as { webhookUrl: string; text?: string }, vars, notice)
      case 'telegram': return sendTelegram(config as unknown as TelegramConfig, vars, notice)
      case 'ntfy': return sendNtfy(config as unknown as NtfyConfig, vars, notice)
      case 'pushover': return sendPushover(config as unknown as PushoverConfig, vars, notice)
      default: throw new Error(`Unsupported notification channel type: ${channel.type}`)
    }
  }

  return { deliver, sendEmail }
}

export type Transports = ReturnType<typeof createTransports>
