import type { ComponentType, ReactNode } from 'react'
import { Field } from '../ui'
import { DiscordIcon, SlackIcon, TeamsIcon } from './icons'

export type ChannelType = 'email' | 'webhook' | 'discord' | 'teams' | 'slack'

const VARS = ['{{monitor_name}}', '{{monitor_type}}', '{{status}}', '{{previous_status}}', '{{error_message}}', '{{checked_at}}', '{{monitor_list}}', '{{affected_count}}', '{{event_type}}', '{{cert_expires_in}}', '{{cert_expires_at}}']

const DEFAULT_EMAIL_SUBJECT = 'Monitor {{monitor_name}} is {{status}}'
const DEFAULT_EMAIL_BODY = `Monitor: {{monitor_name}}
Type:    {{monitor_type}}
Status:  {{status}}
Error:   {{error_message}}
Time:    {{checked_at}}`

const DEFAULT_WEBHOOK_BODY = `{
  "monitor": "{{monitor_name}}",
  "status": "{{status}}",
  "error": "{{error_message}}",
  "time": "{{checked_at}}"
}`

// ── Per-type form state ───────────────────────────────────────────────────────

interface EmailDraft { to: string; subject: string; body: string }
interface WebhookDraft { url: string; method: string; headers: [string, string][]; body: string }
interface DiscordDraft { webhookUrl: string; username: string; content: string }
interface TeamsDraft { webhookUrl: string; summary: string }
interface SlackDraft { webhookUrl: string; text: string }

export interface ChannelDrafts {
  email: EmailDraft
  webhook: WebhookDraft
  discord: DiscordDraft
  teams: TeamsDraft
  slack: SlackDraft
}

export interface ChannelFieldsProps<D> {
  draft: D
  onChange: (draft: D) => void
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
      <Field label="Subject">
        <input value={draft.subject} onChange={(e) => onChange({ ...draft, subject: e.target.value })} required className="input-sig" />
      </Field>
      <Field label="Body">
        <textarea value={draft.body} onChange={(e) => onChange({ ...draft, body: e.target.value })} rows={6} className="input-sig w-full font-mono text-xs" style={{ resize: 'vertical' }} />
      </Field>
      <VarsHint />
    </>
  )
}

function DiscordFields({ draft, onChange }: ChannelFieldsProps<DiscordDraft>) {
  return (
    <>
      <Field label="Webhook URL">
        <input value={draft.webhookUrl} onChange={(e) => onChange({ ...draft, webhookUrl: e.target.value })} required className="input-sig" placeholder="https://discord.com/api/webhooks/…" />
      </Field>
      <Field label="Bot Username (optional)">
        <input value={draft.username} onChange={(e) => onChange({ ...draft, username: e.target.value })} className="input-sig" placeholder="BSP Alerts" />
      </Field>
      <Field label="Message Content (optional)">
        <input value={draft.content} onChange={(e) => onChange({ ...draft, content: e.target.value })} className="input-sig" placeholder="@here Monitor {{monitor_name}} is {{status}}" />
      </Field>
      <InfoBox title="Rich embed is sent automatically">
        Status, monitor name, error message and timestamp are always included in the embed. Message Content is an optional plain-text line above the embed (supports variables).
      </InfoBox>
      <VarsHint />
    </>
  )
}

function TeamsFields({ draft, onChange }: ChannelFieldsProps<TeamsDraft>) {
  return (
    <>
      <Field label="Webhook URL">
        <input value={draft.webhookUrl} onChange={(e) => onChange({ ...draft, webhookUrl: e.target.value })} required className="input-sig" placeholder="https://…webhook.office.com/webhookb2/…" />
      </Field>
      <Field label="Summary (optional)">
        <input value={draft.summary} onChange={(e) => onChange({ ...draft, summary: e.target.value })} className="input-sig" placeholder="Monitor {{monitor_name}} is {{status}}" />
      </Field>
      <InfoBox title="MessageCard is sent automatically">
        Status, monitor name, error and timestamp are included in the card. Summary is the notification toast text — leave blank to use the default.
      </InfoBox>
      <VarsHint />
    </>
  )
}

function SlackFields({ draft, onChange }: ChannelFieldsProps<SlackDraft>) {
  return (
    <>
      <Field label="Webhook URL">
        <input value={draft.webhookUrl} onChange={(e) => onChange({ ...draft, webhookUrl: e.target.value })} required className="input-sig" placeholder="https://hooks.slack.com/services/…" />
      </Field>
      <Field label="Message Text (optional)">
        <input value={draft.text} onChange={(e) => onChange({ ...draft, text: e.target.value })} className="input-sig" placeholder="<!here> Monitor {{monitor_name}} is {{status}}" />
      </Field>
      <InfoBox title="Rich Block Kit message is sent automatically">
        A color-coded card with status, error and timestamp is always included. Message Text is an optional line above the card — use it for <code style={{ fontFamily: 'monospace' }}>{'<!here>'}</code> or <code style={{ fontFamily: 'monospace' }}>{'<!channel>'}</code> mentions.
      </InfoBox>
      <VarsHint />
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

      {webhookHasBody(draft.method) && (
        <Field label="Body">
          <textarea value={draft.body} onChange={(e) => onChange({ ...draft, body: e.target.value })} rows={6} className="input-sig w-full font-mono text-xs" style={{ resize: 'vertical' }} />
        </Field>
      )}
      <VarsHint />
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
    defaultDraft: () => ({ webhookUrl: '', username: '', content: '' }),
    parse: (c) => ({ webhookUrl: str(c['webhookUrl']), username: str(c['username']), content: str(c['content']) }),
    build: (d) => ({
      webhookUrl: d.webhookUrl,
      ...(d.username ? { username: d.username } : {}),
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
}

/** Display order of the type switcher. */
export const CHANNEL_TYPE_ORDER: ChannelType[] = ['email', 'webhook', 'discord', 'teams', 'slack']

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
  return { email: pick('email'), webhook: pick('webhook'), discord: pick('discord'), teams: pick('teams'), slack: pick('slack') }
}

export function buildChannelConfig<K extends ChannelType>(type: K, drafts: ChannelDrafts): Record<string, unknown> {
  return CHANNEL_TYPES[type].build(drafts[type])
}
