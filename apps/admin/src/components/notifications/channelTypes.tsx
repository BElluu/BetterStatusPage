import type { ComponentType, ReactNode } from 'react'
import { Field } from '@better-kit/ui'
import type { VaultRef } from '@better-kit/contracts'
import { CredentialSection } from '@better-kit/ui'
import type { VaultPickerProps } from '@better-kit/ui'
import { DEFAULT_EMAIL_BODY, DEFAULT_EMAIL_SUBJECT } from '@bsp/shared'
import { DiscordIcon, SlackIcon, TeamsIcon, TelegramIcon } from './icons'

export type ChannelType = 'email' | 'webhook' | 'discord' | 'teams' | 'slack' | 'telegram' | 'ntfy' | 'pushover'

/** The variables of every event, then the ones only some events carry. */
const VARS = ['{{monitor_name}}', '{{monitor_type}}', '{{status}}', '{{previous_status}}', '{{error_message}}', '{{checked_at}}', '{{monitor_list}}', '{{affected_count}}', '{{event_type}}']
const VAR_GROUPS: { label: string; vars: string[] }[] = [
  { label: 'Certificate events', vars: ['{{cert_host}}', '{{cert_expires_in}}', '{{cert_expires_at}}', '{{cert_days_left}}'] },
  { label: 'Slower-than-usual events', vars: ['{{latency_p95_ms}}', '{{latency_baseline_ms}}', '{{latency_ratio}}', '{{latency_window_minutes}}', '{{latency_since}}'] },
  { label: 'Action events', vars: ['{{action_name}}', '{{trigger_status}}', '{{attempts}}'] },
]


const DEFAULT_WEBHOOK_BODY = `{
  "monitor": "{{monitor_name}}",
  "status": "{{status}}",
  "error": "{{error_message}}",
  "time": "{{checked_at}}"
}`

// ── Per-type form state ───────────────────────────────────────────────────────

interface EmailDraft { to: string; subject: string; body: string }
interface WebhookDraft { url: string; method: string; headers: [string, string][]; body: string }
interface DiscordDraft { webhookUrl: string; username: string; avatarUrl: string; content: string }
interface TeamsDraft { webhookUrl: string; summary: string }
interface SlackDraft { webhookUrl: string; text: string }
interface TelegramDraft { botToken: string; vault: VaultRef | undefined; chatId: string; text: string }
interface NtfyDraft { serverUrl: string; topic: string; accessToken: string; vault: VaultRef | undefined; text: string }
interface PushoverDraft { appToken: string; vault: VaultRef | undefined; userKey: string; text: string }

export interface ChannelDrafts {
  email: EmailDraft
  webhook: WebhookDraft
  discord: DiscordDraft
  teams: TeamsDraft
  slack: SlackDraft
  telegram: TelegramDraft
  ntfy: NtfyDraft
  pushover: PushoverDraft
}

export interface ChannelFieldsProps<D> {
  draft: D
  onChange: (draft: D) => void
  /** Vaults and their secrets, for the types that can read a credential from the vault. */
  vaultPicker: VaultPickerProps
}

/**
 * Everything the channel form needs to know about one channel type: how it looks in the type switcher,
 * its blank form state, how a stored config is read back into that state, how the state becomes the
 * config the API stores, and the fields that edit it.
 */
export interface ChannelTypeDescriptor<D> {
  label: string
  /** Short line for the quick-start tiles shown while no channel exists yet. */
  hint: string
  icon: (size: number) => ReactNode
  defaultDraft: () => D
  parse: (config: Record<string, unknown>) => D
  build: (draft: D) => Record<string, unknown>
  Fields: ComponentType<ChannelFieldsProps<D>>
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function materialIcon(name: string) {
  return (size: number) => <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: `${size}px` }}>{name}</span>
}

function webhookHasBody(method: string) {
  return method !== 'GET' && method !== 'HEAD'
}

// ── Shared field primitives ───────────────────────────────────────────────────

/** The shared labelled field, re-exported so channel forms keep importing it from here. */
export { Field }

function VarsHint() {
  return (
    <div className="rounded-lg px-3 py-2.5 space-y-1.5" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}>
      <p className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Available variables</p>
      <div className="flex flex-wrap gap-1.5">
        {VARS.map((v) => (
          <code key={v} className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-primary)', fontFamily: 'monospace' }}>{v}</code>
        ))}
      </div>
      {VAR_GROUPS.map((group) => (
        <div key={group.label} className="space-y-1">
          <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>{group.label}</p>
          <div className="flex flex-wrap gap-1.5">
            {group.vars.map((v) => (
              <code key={v} className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-primary)', fontFamily: 'monospace' }}>{v}</code>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function InfoBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg px-3 py-2.5 space-y-1.5" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}>
      <p className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>{title}</p>
      <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>{children}</p>
    </div>
  )
}

// ── Fields per type ───────────────────────────────────────────────────────────

function EmailFields({ draft, onChange }: ChannelFieldsProps<EmailDraft>) {
  return (
    <>
      <Field label="To">
        <input value={draft.to} onChange={(e) => onChange({ ...draft, to: e.target.value })} required className="input-sig" placeholder="ops@example.com" />
      </Field>
    </>
  )
}

function DiscordFields({ draft, onChange }: ChannelFieldsProps<DiscordDraft>) {
  return (
    <>
      <Field label="Webhook URL">
        <input value={draft.webhookUrl} onChange={(e) => onChange({ ...draft, webhookUrl: e.target.value })} onFocus={(e) => e.target.select()} required className="input-sig" placeholder="https://discord.com/api/webhooks/…" />
      </Field>
      <Field label="Bot Username (optional)">
        <input value={draft.username} onChange={(e) => onChange({ ...draft, username: e.target.value })} className="input-sig" placeholder="BSP Alerts" />
      </Field>
      <Field label="Avatar URL (optional)">
        <input value={draft.avatarUrl} onChange={(e) => onChange({ ...draft, avatarUrl: e.target.value })} className="input-sig" placeholder="https://example.com/avatar.png" />
      </Field>
      <InfoBox title="Rich embed is sent automatically">
        Status, monitor name, error message and timestamp are always included in the embed. Message Content is an optional plain-text line above the embed (supports variables).
      </InfoBox>
    </>
  )
}

function TeamsFields({ draft, onChange }: ChannelFieldsProps<TeamsDraft>) {
  return (
    <>
      <Field label="Webhook URL">
        <input value={draft.webhookUrl} onChange={(e) => onChange({ ...draft, webhookUrl: e.target.value })} onFocus={(e) => e.target.select()} required className="input-sig" placeholder="https://…webhook.office.com/webhookb2/…" />
      </Field>
      <InfoBox title="MessageCard is sent automatically">
        Status, monitor name, error and timestamp are included in the card. Summary is the notification toast text — leave blank to use the default.
      </InfoBox>
    </>
  )
}

function SlackFields({ draft, onChange }: ChannelFieldsProps<SlackDraft>) {
  return (
    <>
      <Field label="Webhook URL">
        <input value={draft.webhookUrl} onChange={(e) => onChange({ ...draft, webhookUrl: e.target.value })} onFocus={(e) => e.target.select()} required className="input-sig" placeholder="https://hooks.slack.com/services/…" />
      </Field>
      <InfoBox title="Rich Block Kit message is sent automatically">
        A color-coded card with status, error and timestamp is always included. Message Text is an optional line above the card — use it for <code style={{ fontFamily: 'monospace' }}>{'<!here>'}</code> or <code style={{ fontFamily: 'monospace' }}>{'<!channel>'}</code> mentions.
      </InfoBox>
    </>
  )
}

function TelegramFields({ draft, onChange, vaultPicker }: ChannelFieldsProps<TelegramDraft>) {
  return (
    <>
      <CredentialSection
        {...vaultPicker}
        vault={draft.vault}
        onVaultChange={(vault) => onChange({ ...draft, vault })}
        mappingFields={[]}
        valueLabel="bot token"
        secretTypes={['value']}
      >
        <Field label="Bot Token">
          {/* A stored token comes back masked; selecting it on focus makes replacing it a single paste. */}
          <input value={draft.botToken} onChange={(e) => onChange({ ...draft, botToken: e.target.value })} onFocus={(e) => e.target.select()} required className="input-sig" placeholder="123456789:AA…" autoComplete="off" />
        </Field>
      </CredentialSection>
      <Field label="Chat ID">
        <input value={draft.chatId} onChange={(e) => onChange({ ...draft, chatId: e.target.value })} required className="input-sig" placeholder="-1001234567890 or @channelname" />
      </Field>
      <InfoBox title="Formatted message is sent automatically">
        Status, monitor name, error and timestamp are always included. Message Text is an optional line above them (supports variables). Create the bot with @BotFather and add it to the chat or channel first.
      </InfoBox>
    </>
  )
}

function NtfyFields({ draft, onChange, vaultPicker }: ChannelFieldsProps<NtfyDraft>) {
  return (
    <>
      <Field label="Server URL (optional)">
        <input value={draft.serverUrl} onChange={(e) => onChange({ ...draft, serverUrl: e.target.value })} className="input-sig" placeholder="https://ntfy.sh" />
      </Field>
      <Field label="Topic">
        <input value={draft.topic} onChange={(e) => onChange({ ...draft, topic: e.target.value })} required className="input-sig" placeholder="my-status-alerts" autoComplete="off" />
      </Field>
      <CredentialSection
        {...vaultPicker}
        vault={draft.vault}
        onVaultChange={(vault) => onChange({ ...draft, vault })}
        mappingFields={[]}
        valueLabel="access token"
        secretTypes={['value']}
      >
        <Field label="Access Token (optional)">
          {/* A stored token comes back masked; selecting it on focus makes replacing it a single paste. */}
          <input value={draft.accessToken} onChange={(e) => onChange({ ...draft, accessToken: e.target.value })} onFocus={(e) => e.target.select()} className="input-sig" placeholder="tk_…" autoComplete="off" />
        </Field>
      </CredentialSection>
      <InfoBox title="Push notification is sent automatically">
        A title, status, error and timestamp are always included; a down monitor is sent with high priority. Message Text is an optional line above them (supports variables). Anyone who knows a topic on a public server can read it, so use a hard-to-guess name or an access token.
      </InfoBox>
    </>
  )
}

function PushoverFields({ draft, onChange, vaultPicker }: ChannelFieldsProps<PushoverDraft>) {
  return (
    <>
      <CredentialSection
        {...vaultPicker}
        vault={draft.vault}
        onVaultChange={(vault) => onChange({ ...draft, vault })}
        mappingFields={[]}
        valueLabel="application token"
        secretTypes={['value']}
      >
        <Field label="Application Token">
          {/* A stored token comes back masked; selecting it on focus makes replacing it a single paste. */}
          <input value={draft.appToken} onChange={(e) => onChange({ ...draft, appToken: e.target.value })} onFocus={(e) => e.target.select()} required className="input-sig" placeholder="azGDOR…" autoComplete="off" />
        </Field>
      </CredentialSection>
      <Field label="User Key">
        <input value={draft.userKey} onChange={(e) => onChange({ ...draft, userKey: e.target.value })} required className="input-sig" placeholder="uQiRzp…" autoComplete="off" />
      </Field>
      <InfoBox title="Push notification is sent automatically">
        A title, status, error and timestamp are always included; a down monitor is sent with high priority. Message Text is an optional line above them (supports variables). Create an application at pushover.net/apps/build for the token; the user key is on your Pushover dashboard (a group key works too).
      </InfoBox>
    </>
  )
}

function WebhookFields({ draft, onChange }: ChannelFieldsProps<WebhookDraft>) {
  const setHeaders = (headers: [string, string][]) => onChange({ ...draft, headers })
  const updateHeader = (i: number, field: 0 | 1, val: string) =>
    setHeaders(draft.headers.map((row, idx) => idx === i ? (field === 0 ? [val, row[1]] : [row[0], val]) : row))

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="sm:col-span-2">
          <Field label="URL">
            <input value={draft.url} onChange={(e) => onChange({ ...draft, url: e.target.value })} required className="input-sig" placeholder="https://example.com/alert" />
          </Field>
        </div>
        <Field label="Method">
          <select value={draft.method} onChange={(e) => onChange({ ...draft, method: e.target.value })} className="input-sig">
            <option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option>
          </select>
        </Field>
      </div>

      {/* Headers */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Headers</p>
          <button type="button" onClick={() => setHeaders([...draft.headers, ['', '']])}
            aria-label="Add header"
            className="btn btn-outline btn-sm py-0.5 px-2 text-xs"
          >+ Add</button>
        </div>
        <div className="space-y-1.5">
          {draft.headers.map(([k, v], i) => (
            <div key={i} className="flex gap-1.5 items-center">
              <input className="input-sig text-xs flex-1 min-w-0" placeholder="Header" aria-label={`Header ${i + 1} name`} value={k} onChange={(e) => updateHeader(i, 0, e.target.value)} />
              <input className="input-sig text-xs flex-1 min-w-0" placeholder="Value" aria-label={`Header ${i + 1} value`} value={v} onChange={(e) => updateHeader(i, 1, e.target.value)} />
              <button type="button" onClick={() => setHeaders(draft.headers.filter((_, idx) => idx !== i))}
                aria-label={`Remove header ${k || i + 1}`}
                className="btn-icon w-7 h-7"
              >
                <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px' }}>close</span>
              </button>
            </div>
          ))}
          {draft.headers.length === 0 && <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>No custom headers.</p>}
        </div>
      </div>

    </>
  )
}

// ── Descriptor table ──────────────────────────────────────────────────────────

export const CHANNEL_TYPES: { [K in ChannelType]: ChannelTypeDescriptor<ChannelDrafts[K]> } = {
  email: {
    label: 'Email',
    hint: 'Uses the SMTP settings',
    icon: materialIcon('mail'),
    defaultDraft: () => ({ to: '', subject: DEFAULT_EMAIL_SUBJECT, body: DEFAULT_EMAIL_BODY }),
    parse: (c) => ({ to: str(c['to']), subject: str(c['subject'], DEFAULT_EMAIL_SUBJECT), body: str(c['body'], DEFAULT_EMAIL_BODY) }),
    build: (d) => ({ to: d.to, subject: d.subject, body: d.body }),
    Fields: EmailFields,
  },
  webhook: {
    label: 'Webhook',
    hint: 'Any HTTP endpoint',
    icon: materialIcon('webhook'),
    defaultDraft: () => ({ url: '', method: 'POST', headers: [], body: DEFAULT_WEBHOOK_BODY }),
    parse: (c) => ({
      url: str(c['url']),
      method: str(c['method'], 'POST'),
      headers: Object.entries((c['headers'] as Record<string, string> | undefined) ?? {}),
      body: str(c['body'], DEFAULT_WEBHOOK_BODY),
    }),
    build: (d) => {
      const headers: Record<string, string> = {}
      for (const [k, v] of d.headers) { if (k) headers[k] = v }
      return {
        url: d.url,
        method: d.method,
        headers: Object.keys(headers).length ? headers : undefined,
        body: webhookHasBody(d.method) && d.body ? d.body : undefined,
      }
    },
    Fields: WebhookFields,
  },
  discord: {
    label: 'Discord',
    hint: 'Channel webhook',
    icon: (size) => <DiscordIcon size={size} />,
    defaultDraft: () => ({ webhookUrl: '', username: '', avatarUrl: '', content: '' }),
    parse: (c) => ({ webhookUrl: str(c['webhookUrl']), username: str(c['username']), avatarUrl: str(c['avatarUrl']), content: str(c['content']) }),
    build: (d) => ({
      webhookUrl: d.webhookUrl,
      ...(d.username ? { username: d.username } : {}),
      ...(d.avatarUrl ? { avatarUrl: d.avatarUrl } : {}),
      ...(d.content ? { content: d.content } : {}),
    }),
    Fields: DiscordFields,
  },
  teams: {
    label: 'Teams',
    hint: 'Workflow webhook',
    icon: (size) => <TeamsIcon size={size} />,
    defaultDraft: () => ({ webhookUrl: '', summary: '' }),
    parse: (c) => ({ webhookUrl: str(c['webhookUrl']), summary: str(c['summary']) }),
    build: (d) => ({ webhookUrl: d.webhookUrl, ...(d.summary ? { summary: d.summary } : {}) }),
    Fields: TeamsFields,
  },
  slack: {
    label: 'Slack',
    hint: 'Incoming webhook',
    icon: (size) => <SlackIcon size={size} />,
    defaultDraft: () => ({ webhookUrl: '', text: '' }),
    parse: (c) => ({ webhookUrl: str(c['webhookUrl']), text: str(c['text']) }),
    build: (d) => ({ webhookUrl: d.webhookUrl, ...(d.text ? { text: d.text } : {}) }),
    Fields: SlackFields,
  },
  telegram: {
    label: 'Telegram',
    hint: 'Bot and chat ID',
    icon: (size) => <TelegramIcon size={size} />,
    defaultDraft: () => ({ botToken: '', vault: undefined, chatId: '', text: '' }),
    parse: (c) => ({ botToken: str(c['botToken']), vault: (c['vault'] as VaultRef | undefined) ?? undefined, chatId: str(c['chatId']), text: str(c['text']) }),
    build: (d) => ({ ...(d.vault ? { vault: d.vault } : { botToken: d.botToken.trim() }), chatId: d.chatId.trim(), ...(d.text ? { text: d.text } : {}) }),
    Fields: TelegramFields,
  },
  ntfy: {
    label: 'ntfy',
    hint: 'Topic on ntfy.sh or your server',
    icon: materialIcon('notifications_active'),
    defaultDraft: () => ({ serverUrl: '', topic: '', accessToken: '', vault: undefined, text: '' }),
    parse: (c) => ({ serverUrl: str(c['serverUrl']), topic: str(c['topic']), accessToken: str(c['accessToken']), vault: (c['vault'] as VaultRef | undefined) ?? undefined, text: str(c['text']) }),
    build: (d) => ({
      ...(d.serverUrl.trim() ? { serverUrl: d.serverUrl.trim() } : {}),
      topic: d.topic.trim(),
      ...(d.vault ? { vault: d.vault } : d.accessToken.trim() ? { accessToken: d.accessToken.trim() } : {}),
      ...(d.text ? { text: d.text } : {}),
    }),
    Fields: NtfyFields,
  },
  pushover: {
    label: 'Pushover',
    hint: 'Application token and user key',
    icon: materialIcon('campaign'),
    defaultDraft: () => ({ appToken: '', vault: undefined, userKey: '', text: '' }),
    parse: (c) => ({ appToken: str(c['appToken']), vault: (c['vault'] as VaultRef | undefined) ?? undefined, userKey: str(c['userKey']), text: str(c['text']) }),
    build: (d) => ({ ...(d.vault ? { vault: d.vault } : { appToken: d.appToken.trim() }), userKey: d.userKey.trim(), ...(d.text ? { text: d.text } : {}) }),
    Fields: PushoverFields,
  },
}

/** Display order of the type switcher. */
export const CHANNEL_TYPE_ORDER: ChannelType[] = ['email', 'webhook', 'discord', 'teams', 'slack', 'telegram', 'ntfy', 'pushover']

export function isChannelType(value: unknown): value is ChannelType {
  return typeof value === 'string' && value in CHANNEL_TYPES
}

/**
 * One draft per type, so switching types in the form keeps what was typed for each. The stored channel's
 * own type is read back from its config; every other type starts blank.
 */
export function initialDrafts(type: ChannelType | null, config: unknown): ChannelDrafts {
  const stored = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>
  const pick = <K extends ChannelType>(k: K): ChannelDrafts[K] =>
    (type === k ? CHANNEL_TYPES[k].parse(stored) : CHANNEL_TYPES[k].defaultDraft())
  return { email: pick('email'), webhook: pick('webhook'), discord: pick('discord'), teams: pick('teams'), slack: pick('slack'), telegram: pick('telegram'), ntfy: pick('ntfy'), pushover: pick('pushover') }
}

/** What the Action tab of the form sets: the wording of action messages, and whether a run that succeeded is told too. */
export interface ActionSettings {
  texts?: ActionTexts | undefined
  notifyOnSuccess?: boolean | undefined
  /** The wording the stored channel has for other kinds of event, which the form does not edit but must not lose. */
  otherOverrides?: Record<string, Record<string, string>> | undefined
}

export function buildChannelConfig<K extends ChannelType>(type: K, drafts: ChannelDrafts, action: ActionSettings = {}): Record<string, unknown> {
  // A webhook that cannot carry a body (GET) has none to word, like the Monitor tab.
  const canWord = (key: string) => type !== 'webhook' || key !== 'body' || webhookHasBody(drafts.webhook.method)
  const texts = Object.fromEntries(Object.entries(action.texts ?? {}).filter(([key, text]) => text !== '' && canWord(key)))
  const overrides = { ...(action.otherOverrides ?? {}), ...(Object.keys(texts).length ? { action: texts } : {}) }
  return {
    ...CHANNEL_TYPES[type].build(drafts[type]),
    ...(action.notifyOnSuccess ? { notifyOnActionSuccess: true } : {}),
    ...(Object.keys(overrides).length ? { eventOverrides: overrides } : {}),
  }
}

/** The wording a stored config has for kinds of event other than an action's. */
export function readOtherOverrides(config: unknown): Record<string, Record<string, string>> | undefined {
  const all = (config && typeof config === 'object' ? (config as Record<string, unknown>)['eventOverrides'] : undefined) as Record<string, Record<string, string>> | undefined
  if (!all || typeof all !== 'object') return undefined
  const { action: _action, ...others } = all
  return Object.keys(others).length ? others : undefined
}

// ── Message wording, per kind of event ────────────────────────────────────────

/** The kinds of event a channel words separately: what a monitor does, and what an action does. */
export type MessageScope = 'monitor' | 'action'

/** The wording an action message has for each channel type, by field; empty fields fall back to the Monitor tab. */
export type ActionTexts = Record<string, string>

interface MessageField {
  key: string
  label: string
  /** Rows of a multi-line field; a single line when absent. */
  rows?: number
  placeholder: Record<MessageScope, string>
}

const monitorLine = 'Monitor {{monitor_name}} is {{status}}'
const actionLine = 'Action {{action_name}} {{status}} for {{monitor_name}}'
const single = (key: string, label: string, monitor: string, action: string): MessageField[] =>
  [{ key, label, placeholder: { monitor, action } }]

/** The fields that word a message, which are the fields of `TEMPLATE_KEYS` in the notify package. */
const MESSAGE_FIELDS: Record<ChannelType, MessageField[]> = {
  email: [
    { key: 'subject', label: 'Subject', placeholder: { monitor: monitorLine, action: actionLine } },
    { key: 'body', label: 'Body', rows: 6, placeholder: { monitor: '', action: 'Action:  {{action_name}}\nMonitor: {{monitor_name}}\nResult:  {{status}}\nAttempts: {{attempts}}\nError:   {{error_message}}' } },
  ],
  webhook: [{ key: 'body', label: 'Body (JSON)', rows: 6, placeholder: { monitor: '', action: '{\n  "action": "{{action_name}}",\n  "monitor": "{{monitor_name}}",\n  "status": "{{status}}",\n  "trigger_status": "{{trigger_status}}",\n  "attempts": "{{attempts}}",\n  "error": "{{error_message}}",\n  "time": "{{checked_at}}"\n}' } }],
  discord: single('content', 'Message Content (optional)', '@here ' + monitorLine, '@here ' + actionLine),
  teams: single('summary', 'Summary (optional)', monitorLine, actionLine),
  slack: single('text', 'Message Text (optional)', '<!here> ' + monitorLine, '<!here> ' + actionLine),
  telegram: single('text', 'Message Text (optional)', monitorLine, actionLine),
  ntfy: single('text', 'Message Text (optional)', monitorLine, actionLine),
  pushover: single('text', 'Message Text (optional)', monitorLine, actionLine),
}

/** What the stored config says an action message should look like, for the fields this type has. */
export function readActionTexts(type: ChannelType, config: unknown): ActionTexts {
  const overrides = (config && typeof config === 'object' ? (config as Record<string, unknown>)['eventOverrides'] : undefined) as Record<string, unknown> | undefined
  const stored = overrides?.['action']
  const texts: ActionTexts = {}
  if (stored && typeof stored === 'object') {
    for (const { key } of MESSAGE_FIELDS[type]) {
      const value = (stored as Record<string, unknown>)[key]
      if (typeof value === 'string') texts[key] = value
    }
  }
  return texts
}

/** The message fields of one tab. A webhook without a body (GET) has none to word. */
export function MessageSection<K extends ChannelType>({ type, scope, drafts, onDraft, actionTexts, onActionTexts }: {
  type: K
  scope: MessageScope
  drafts: ChannelDrafts
  onDraft: (type: K, draft: ChannelDrafts[K]) => void
  actionTexts: ActionTexts
  onActionTexts: (texts: ActionTexts) => void
}) {
  const draft = drafts[type] as unknown as Record<string, string>
  const hasBody = type !== 'webhook' || webhookHasBody(draft['method'] ?? 'POST')
  return (
    <>
      {hasBody && MESSAGE_FIELDS[type].map((field) => {
        const value = scope === 'monitor' ? draft[field.key] ?? '' : actionTexts[field.key] ?? ''
        const set = (next: string) => scope === 'monitor'
          ? onDraft(type, { ...drafts[type], [field.key]: next })
          : onActionTexts({ ...actionTexts, [field.key]: next })
        return (
          <Field key={field.key} label={field.label}>
            {field.rows
              ? <textarea value={value} onChange={(e) => set(e.target.value)} rows={field.rows} className="input-sig w-full font-mono text-xs" style={{ resize: 'vertical' }} placeholder={field.placeholder[scope]} />
              : <input value={value} onChange={(e) => set(e.target.value)} required={scope === 'monitor' && type === 'email'} className="input-sig" placeholder={field.placeholder[scope]} />}
          </Field>
        )
      })}
      <VarsHint />
    </>
  )
}
