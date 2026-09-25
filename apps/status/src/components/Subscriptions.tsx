import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MAX_WEBHOOK_HEADERS, WEBHOOK_METHODS } from '@bsp/shared'
import type {
  PublicSubscriptionOptions, SubscriberEventType, SubscriberType, SubscriptionMethod, SubscriptionPreferences, TranslationKey,
  WebhookHeader, WebhookMethod,
} from '@bsp/shared'
import { useLocale } from '../i18n/LocaleContext'

const API = '/api/v1/public/subscriptions'

export const EVENT_LABEL_KEYS: Record<SubscriberEventType, TranslationKey> = {
  'incident.created': 'subscribe.event.incidentCreated',
  'incident.updated': 'subscribe.event.incidentUpdated',
  'incident.resolved': 'subscribe.event.incidentResolved',
  'maintenance.scheduled': 'subscribe.event.maintenanceScheduled',
}

export const FEED_URL = '/api/v1/public/incidents.rss'


export function useSubscriptionOptions() {
  return useQuery<PublicSubscriptionOptions>({
    queryKey: ['subscription-options'],
    queryFn: async () => {
      const res = await fetch(`${API}/options`)
      if (!res.ok) throw new Error('Failed to load subscription options')
      return res.json()
    },
    staleTime: 0,
  })
}

async function send<T>(method: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({})) as T & { error?: string }
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status })
  return data
}

// ── Shared building blocks ───────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: '10px',
  border: '1px solid var(--bsp-card-border)',
  background: 'var(--bsp-bg)',
  color: 'var(--bsp-text)',
  fontSize: '14px',
  outline: 'none',
}

function PrimaryButton({ children, disabled, onClick, type = 'button' }: {
  children: ReactNode; disabled?: boolean; onClick?: () => void; type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className="bsp-subscribe-primary bsp-action px-5 py-2.5 rounded-xl text-sm font-bold transition-all active:scale-[0.98]"
      style={{ background: 'var(--bsp-action-bg)', color: 'var(--bsp-action-fg)', opacity: disabled ? 0.6 : 1 }}
    >
      {children}
    </button>
  )
}

function SecondaryButton({ children, onClick, danger }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
      style={{ color: danger ? 'var(--bsp-down)' : 'var(--bsp-text-muted)', background: 'transparent' }}
    >
      {children}
    </button>
  )
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useLocale()
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    panel.current?.querySelector<HTMLElement>('input, button')?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="bsp-subscribe-overlay"
      style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.5)', overflowY: 'auto' }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div style={{ display: 'flex', minHeight: '100%', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="bsp-subscribe-dialog w-full max-w-md rounded-2xl"
          style={{ background: 'var(--bsp-card-bg)', border: '1px solid var(--bsp-card-border)', color: 'var(--bsp-text)' }}
        >
          <div className="flex items-center justify-between px-6 pt-5 pb-3">
            <h2 id={titleId} className="font-headline font-bold text-lg">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('subscribe.close')}
              className="w-8 h-8 flex items-center justify-center rounded-lg"
              style={{ color: 'var(--bsp-text-muted)' }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>close</span>
            </button>
          </div>
          <div className="px-6 pb-6">{children}</div>
        </div>
      </div>
    </div>
  )
}

function Notice({ tone, children }: { tone: 'ok' | 'error'; children: ReactNode }) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className="text-sm rounded-xl px-3 py-2.5"
      style={{
        color: tone === 'ok' ? 'var(--bsp-text)' : 'var(--bsp-down)',
        background: tone === 'ok'
          ? 'color-mix(in srgb, var(--bsp-up) 14%, transparent)'
          : 'color-mix(in srgb, var(--bsp-down) 12%, transparent)',
      }}
    >
      {children}
    </p>
  )
}

function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="block text-xs font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--bsp-text-muted)' }}>
      {children}
    </label>
  )
}

interface Scope {
  events: SubscriberEventType[]
  monitorIds: number[]
  tags: string[]
}

/** Event checkboxes plus, when allowed, a component and tag picker. */
function ScopeFields({ options, scope, onChange }: { options: PublicSubscriptionOptions; scope: Scope; onChange: (scope: Scope) => void }) {
  const { t } = useLocale()
  const [pickComponents, setPickComponents] = useState(scope.monitorIds.length > 0 || scope.tags.length > 0)
  const toggle = <T,>(list: T[], item: T, on: boolean) => (on ? [...list, item] : list.filter((x) => x !== item))

  return (
    <>
      <fieldset>
        <legend className="block text-xs font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--bsp-text-muted)' }}>{t('subscribe.events')}</legend>
        <div className="space-y-2">
          {options.events.map((type) => (
            <label key={type} className="flex items-center gap-2.5 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={scope.events.includes(type)}
                onChange={(e) => onChange({ ...scope, events: toggle(scope.events, type, e.target.checked) })}
              />
              {t(EVENT_LABEL_KEYS[type])}
            </label>
          ))}
        </div>
      </fieldset>

      {options.allowComponentScope && (
        <fieldset>
          <legend className="block text-xs font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--bsp-text-muted)' }}>{t('subscribe.components')}</legend>
          <label className="flex items-center gap-2.5 text-sm cursor-pointer mb-2">
            <input
              type="checkbox"
              checked={!pickComponents}
              onChange={(e) => {
                setPickComponents(!e.target.checked)
                if (e.target.checked) onChange({ ...scope, monitorIds: [], tags: [] })
              }}
            />
            {t('subscribe.allComponents')}
          </label>
          {pickComponents && (
            <div className="space-y-3 pl-1">
              <div className="max-h-40 overflow-y-auto space-y-1.5 rounded-xl p-2.5" style={{ border: '1px solid var(--bsp-card-border)' }}>
                {options.components.map((component) => (
                  <label key={component.id} className="flex items-center gap-2.5 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={scope.monitorIds.includes(component.id)}
                      onChange={(e) => onChange({ ...scope, monitorIds: toggle(scope.monitorIds, component.id, e.target.checked) })}
                    />
                    {component.name}
                  </label>
                ))}
              </div>
              {options.tags.length > 0 && (
                <div>
                  <p className="text-xs mb-1.5" style={{ color: 'var(--bsp-text-muted)' }}>{t('subscribe.tags')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {options.tags.map((tag) => {
                      const on = scope.tags.includes(tag)
                      return (
                        <button
                          key={tag}
                          type="button"
                          aria-pressed={on}
                          onClick={() => onChange({ ...scope, tags: toggle(scope.tags, tag, !on) })}
                          className="text-xs px-2.5 py-1 rounded-full font-medium"
                          style={{
                            border: '1px solid var(--bsp-card-border)',
                            backgroundColor: on ? 'var(--bsp-action-bg)' : 'transparent',
                            color: on ? 'var(--bsp-action-fg)' : 'var(--bsp-text)',
                          }}
                        >
                          {tag}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </fieldset>
      )}
    </>
  )
}

function scopeIsValid(scope: Scope): boolean {
  return scope.events.length > 0
}

// ── Webhook options ──────────────────────────────────────────────────────────

interface WebhookConfig {
  method: WebhookMethod
  headers: WebhookHeader[]
  notifyOnFailure: boolean
}

const EXAMPLE_PAYLOAD = JSON.stringify({
  event: 'incident.updated',
  occurredAt: '2026-09-24T10:15:00.000Z',
  meta: { manageUrl: '…', unsubscribeUrl: '…' },
  page: { name: 'Status Page', url: 'https://status.example.com/' },
  incident: {
    id: 12, title: 'Checkout errors', status: 'identified', impact: 'major',
    startedAt: '2026-09-24T09:58:00.000Z', resolvedAt: null, url: 'https://status.example.com/',
    updates: [{ body: 'Rolling back the last deploy.', status: 'identified', postedAt: '2026-09-24T10:15:00.000Z' }],
  },
  update: { body: 'Rolling back the last deploy.', status: 'identified', postedAt: '2026-09-24T10:15:00.000Z' },
  components: [{ id: 3, name: 'Checkout API' }],
}, null, 2)

/**
 * Failure alerts, and the "Customize" panel for the request itself. On the manage page the saved
 * header values are never sent back, so an empty value field there means "keep the current value".
 */
function WebhookOptions({ config, onChange, savedHeaderNames = [] }: {
  config: WebhookConfig
  onChange: (config: WebhookConfig) => void
  savedHeaderNames?: string[]
}) {
  const { t } = useLocale()
  const methodId = useId()
  const [open, setOpen] = useState(config.method !== 'POST' || config.headers.length > 0)
  const setHeader = (index: number, patch: Partial<WebhookHeader>) =>
    onChange({ ...config, headers: config.headers.map((header, i) => (i === index ? { ...header, ...patch } : header)) })
  const isSaved = (name: string) => savedHeaderNames.some((saved) => saved.toLowerCase() === name.trim().toLowerCase())

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2.5 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={config.notifyOnFailure}
          onChange={(e) => onChange({ ...config, notifyOnFailure: e.target.checked })}
        />
        {t('subscribe.notifyOnFailure')}
      </label>

      <div className="rounded-xl" style={{ border: '1px solid var(--bsp-card-border)' }}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="w-full flex items-center justify-between px-3 py-2.5 text-sm font-semibold"
        >
          {t('subscribe.customize')}
          <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>{open ? 'expand_less' : 'expand_more'}</span>
        </button>
        {open && (
          <div className="px-3 pb-3 space-y-4">
            <div>
              <FieldLabel htmlFor={methodId}>{t('subscribe.method')}</FieldLabel>
              <select
                id={methodId}
                value={config.method}
                onChange={(e) => onChange({ ...config, method: e.target.value as WebhookMethod })}
                style={inputStyle}
              >
                {WEBHOOK_METHODS.map((method) => <option key={method} value={method}>{method}</option>)}
              </select>
            </div>

            <fieldset>
              <legend className="block text-xs font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--bsp-text-muted)' }}>{t('subscribe.headers')}</legend>
              <div className="space-y-2">
                {config.headers.map((header, index) => (
                  <div key={index} className="flex gap-2">
                    <input
                      aria-label={t('subscribe.headerName')}
                      placeholder={t('subscribe.headerName')}
                      value={header.name}
                      onChange={(e) => setHeader(index, { name: e.target.value })}
                      style={{ ...inputStyle, flex: '0 0 40%' }}
                    />
                    <input
                      aria-label={t('subscribe.headerValue')}
                      placeholder={isSaved(header.name) ? t('subscribe.headerUnchanged') : t('subscribe.headerValue')}
                      value={header.value}
                      onChange={(e) => setHeader(index, { value: e.target.value })}
                      style={{ ...inputStyle, minWidth: 0 }}
                    />
                    <button
                      type="button"
                      aria-label={t('subscribe.removeHeader')}
                      onClick={() => onChange({ ...config, headers: config.headers.filter((_, i) => i !== index) })}
                      className="px-2 rounded-lg flex-shrink-0"
                      style={{ color: 'var(--bsp-text-muted)' }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>close</span>
                    </button>
                  </div>
                ))}
                {config.headers.length < MAX_WEBHOOK_HEADERS && (
                  <button
                    type="button"
                    onClick={() => onChange({ ...config, headers: [...config.headers, { name: '', value: '' }] })}
                    className="inline-flex items-center gap-1 text-sm font-semibold"
                    style={{ color: 'var(--bsp-text-muted)' }}
                  >
                    <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>add</span>
                    {t('subscribe.addHeader')}
                  </button>
                )}
              </div>
            </fieldset>

            <details>
              <summary className="text-xs cursor-pointer" style={{ color: 'var(--bsp-text-muted)' }}>{t('subscribe.payloadExample')}</summary>
              <pre
                className="text-xs mt-2 p-3 rounded-xl overflow-x-auto"
                style={{ background: 'var(--bsp-bg)', border: '1px solid var(--bsp-card-border)', fontFamily: 'monospace' }}
              >
                {EXAMPLE_PAYLOAD}
              </pre>
            </details>
          </div>
        )}
      </div>
    </div>
  )
}

/** Blank header rows are dropped instead of being rejected by the server. */
function cleanHeaders(headers: WebhookHeader[], savedHeaderNames: string[] = []): WebhookHeader[] {
  return headers.filter((header) => header.name.trim() && (header.value || savedHeaderNames.some(
    (saved) => saved.toLowerCase() === header.name.trim().toLowerCase(),
  ))).map((header) => ({ name: header.name.trim(), value: header.value }))
}

// ── Subscribe form ───────────────────────────────────────────────────────────

export const METHOD_INFO: Record<SubscriptionMethod, { icon: string; label: TranslationKey; description: TranslationKey }> = {
  email:   { icon: 'mail',        label: 'subscribe.channelEmail',   description: 'subscribe.methodEmailDesc' },
  webhook: { icon: 'webhook',     label: 'subscribe.channelWebhook', description: 'subscribe.methodWebhookDesc' },
  slack:   { icon: 'forum',       label: 'subscribe.channelSlack',   description: 'subscribe.methodSlackDesc' },
  rss:     { icon: 'rss_feed',    label: 'subscribe.channelRss',     description: 'subscribe.methodRssDesc' },
  api:     { icon: 'data_object', label: 'subscribe.channelApi',     description: 'subscribe.methodApiDesc' },
}

/** Every method a visitor can pick, one per row, so the choice is always explicit. */
function MethodChooser({ methods, onChoose }: { methods: SubscriptionMethod[]; onChoose: (method: SubscriptionMethod) => void }) {
  const { t } = useLocale()
  return (
    <div className="space-y-4">
      <p className="text-sm" style={{ color: 'var(--bsp-text-muted)' }}>{t('subscribe.chooseMethod')}</p>
      <ul className="space-y-2">
        {methods.map((method) => (
          <li key={method}>
            <button
              type="button"
              onClick={() => onChoose(method)}
              className="bsp-subscribe-method w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-colors"
              style={{ border: '1px solid var(--bsp-card-border)' }}
            >
              <span className="material-symbols-outlined flex-shrink-0" aria-hidden="true" style={{ fontSize: '22px', color: 'var(--bsp-text-muted)' }}>
                {METHOD_INFO[method].icon}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-bold">{t(METHOD_INFO[method].label)}</span>
                <span className="block text-xs mt-0.5" style={{ color: 'var(--bsp-text-muted)' }}>{t(METHOD_INFO[method].description)}</span>
              </span>
              <span className="material-symbols-outlined flex-shrink-0" aria-hidden="true" style={{ fontSize: '18px', color: 'var(--bsp-text-muted)' }}>chevron_right</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function SubscribeDialog({ options, onClose }: { options: PublicSubscriptionOptions; onClose: () => void }) {
  const { t } = useLocale()
  const [method, setMethod] = useState<SubscriptionMethod | null>(null)
  const title = method ? t(METHOD_INFO[method].label) : t('subscribe.title')

  return (
    <Dialog title={title} onClose={onClose}>
      {method === null ? (
        <MethodChooser methods={options.methods} onChoose={setMethod} />
      ) : (
        <div className="space-y-5">
          <button
            type="button"
            onClick={() => setMethod(null)}
            className="inline-flex items-center gap-1 text-sm font-semibold -mt-1"
            style={{ color: 'var(--bsp-text-muted)' }}
          >
            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>arrow_back</span>
            {t('subscribe.back')}
          </button>
          {method === 'slack' ? <SlackInstructions base={publicBase(options)} />
            : method === 'rss' ? <RssInstructions base={publicBase(options)} />
            : method === 'api' ? <ApiInstructions base={publicBase(options)} />
            : <SignupForm type={method} options={options} onClose={onClose} />}
        </div>
      )}
    </Dialog>
  )
}

/** The email and webhook signup, which needs confirmation by email. */
function SignupForm({ type, options, onClose }: { type: SubscriberType; options: PublicSubscriptionOptions; onClose: () => void }) {
  const { t } = useLocale()
  const emailId = useId()
  const urlId = useId()
  const [email, setEmail] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [webhook, setWebhook] = useState<WebhookConfig>({ method: 'POST', headers: [], notifyOnFailure: true })
  const [website, setWebsite] = useState('')
  const [scope, setScope] = useState<Scope>({ events: [...options.events], monitorIds: [], tags: [] })
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle')
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setState('sending')
    try {
      const webhookFields = type === 'webhook'
        ? { webhookUrl, webhookMethod: webhook.method, webhookHeaders: cleanHeaders(webhook.headers), notifyOnFailure: webhook.notifyOnFailure }
        : {}
      await send('POST', '', { type, email, ...webhookFields, ...scope, website })
      setState('done')
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('subscribe.error'))
      setState('idle')
    }
  }

  if (state === 'done') {
    return (
      <div className="space-y-4">
        <Notice tone="ok">{t('subscribe.checkInbox')}</Notice>
        <div className="flex justify-end"><PrimaryButton onClick={onClose}>{t('subscribe.close')}</PrimaryButton></div>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <p className="text-sm" style={{ color: 'var(--bsp-text-muted)' }}>{t('subscribe.intro')}</p>

      {type === 'webhook' && (
        <div>
          <FieldLabel htmlFor={urlId}>{t('subscribe.webhookUrl')}</FieldLabel>
          <input id={urlId} type="url" required placeholder="https://" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} style={inputStyle} />
          <p className="text-xs mt-1.5" style={{ color: 'var(--bsp-text-muted)' }}>{t('subscribe.webhookHint')}</p>
        </div>
      )}

      <div>
        <FieldLabel htmlFor={emailId}>{t('subscribe.email')}</FieldLabel>
        <input id={emailId} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} />
        {type === 'webhook' && <p className="text-xs mt-1.5" style={{ color: 'var(--bsp-text-muted)' }}>{t('subscribe.webhookEmailHint')}</p>}
      </div>

      {type === 'webhook' && <WebhookOptions config={webhook} onChange={setWebhook} />}

      {/* Honeypot: hidden from people and assistive tech, irresistible to form-filling bots. */}
      <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: '1px', height: '1px', overflow: 'hidden' }}>
        <label>Leave this field empty<input type="text" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} /></label>
      </div>

      <ScopeFields options={options} scope={scope} onChange={setScope} />

      {error && <Notice tone="error">{error}</Notice>}

      <div className="flex justify-end pt-1">
        <PrimaryButton type="submit" disabled={state === 'sending' || !scopeIsValid(scope)}>
          {state === 'sending' ? t('subscribe.submitting') : t('subscribe.submit')}
        </PrimaryButton>
      </div>
    </form>
  )
}

export const ATOM_FEED_URL = '/api/v1/public/incidents.atom'

function RssInstructions({ base }: { base: string }) {
  const { t } = useLocale()
  return (
    <div className="space-y-4">
      <p className="text-sm">{t('subscribe.rssHint')}</p>
      {[{ label: 'RSS', path: FEED_URL }, { label: 'Atom', path: ATOM_FEED_URL }].map((feed) => (
        <div key={feed.path} className="space-y-1.5">
          <p className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--bsp-text-muted)' }}>{feed.label}</p>
          <CopyField value={`${base}${feed.path}`} />
        </div>
      ))}
    </div>
  )
}

export const SLACK_FEED_URL = '/api/v1/public/slack.rss'

/**
 * Every link shown to visitors — Slack, feeds and the API alike — starts from the server's
 * PUBLIC_URL, so they all agree. Without it, this page's own address is the best guess.
 */
export function publicBase(options: Pick<PublicSubscriptionOptions, 'baseUrl'>): string {
  return options.baseUrl ?? window.location.origin
}

/**
 * Slack has no signup step: its built-in RSS app polls the event feed and posts each new item.
 * The visitor only needs the command to paste into a channel.
 */
function SlackInstructions({ base }: { base: string }) {
  const { t } = useLocale()
  return (
    <div className="space-y-3">
      <p className="text-sm">{t('subscribe.slackHint')}</p>
      <CopyField value={`/feed subscribe ${base}${SLACK_FEED_URL}`} />
    </div>
  )
}

export const STATUS_API_ENDPOINTS: Array<{ path: string; label: TranslationKey }> = [
  { path: '/api/v1/public/summary.json', label: 'subscribe.apiSummary' },
  { path: '/api/v1/public/components.json', label: 'subscribe.apiComponents' },
]

/** The read-only JSON API needs no signup either — just the endpoints to poll. */
function ApiInstructions({ base }: { base: string }) {
  const { t } = useLocale()
  return (
    <div className="space-y-4">
      <p className="text-sm">{t('subscribe.apiHint')}</p>
      {STATUS_API_ENDPOINTS.map((endpoint) => (
        <div key={endpoint.path} className="space-y-1.5">
          <p className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--bsp-text-muted)' }}>
            GET · {t(endpoint.label)}
          </p>
          <CopyField value={`${base}${endpoint.path}`} />
        </div>
      ))}
    </div>
  )
}

function CopyField({ value }: { value: string }) {
  const { t } = useLocale()
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard blocked — the text stays selectable */ }
  }

  return (
    <div className="flex items-stretch gap-2">
      <code
        className="flex-1 min-w-0 text-xs px-3 py-2.5 rounded-xl break-all select-all"
        style={{ background: 'var(--bsp-bg)', border: '1px solid var(--bsp-card-border)', fontFamily: 'monospace' }}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        className="bsp-action px-3 rounded-xl text-sm font-bold flex-shrink-0"
        style={{ background: 'var(--bsp-action-bg)', color: 'var(--bsp-action-fg)' }}
      >
        {copied ? t('subscribe.copied') : t('subscribe.copy')}
      </button>
    </div>
  )
}

// ── Links from emails: confirm, manage, unsubscribe ──────────────────────────

type LinkMode = 'confirm' | 'manage' | 'unsubscribe'

/** Tokens travel in the URL fragment so they never reach server logs or Referer headers. */
export function readSubscriptionLink(): { mode: LinkMode; token: string } | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const mode = params.get('subscription')
  const token = params.get('token')
  if (!token || (mode !== 'confirm' && mode !== 'manage' && mode !== 'unsubscribe')) return null
  return { mode, token }
}

/** Drops the token from the address bar and history once the dialog holds it. */
export function clearSubscriptionLink(): void {
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
}

/** Saved header values stay on the server, so the editor starts with names and empty values. */
function webhookConfigFrom(prefs: SubscriptionPreferences): WebhookConfig | null {
  if (prefs.type !== 'webhook') return null
  return {
    method: prefs.webhookMethod ?? 'POST',
    headers: prefs.webhookHeaderNames.map((name) => ({ name, value: '' })),
    notifyOnFailure: prefs.notifyOnFailure,
  }
}

export function SubscriptionLinkDialog({ link, options, onClose }: {
  link: { mode: LinkMode; token: string }
  options: PublicSubscriptionOptions | undefined
  onClose: () => void
}) {
  const { t } = useLocale()
  const [mode, setMode] = useState<LinkMode>(link.mode)
  const [token, setToken] = useState(link.token)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [prefs, setPrefs] = useState<SubscriptionPreferences | null>(null)
  const [scope, setScope] = useState<Scope | null>(null)
  const [webhook, setWebhook] = useState<WebhookConfig | null>(null)
  const [invalid, setInvalid] = useState(false)

  function fail(err: unknown) {
    const status = (err as { status?: number }).status
    if (status === 404) setInvalid(true)
    else setNotice({ tone: 'error', text: err instanceof Error && err.message ? err.message : t('subscribe.error') })
  }

  useEffect(() => {
    if (mode !== 'manage') return
    let cancelled = false
    send<SubscriptionPreferences>('POST', '/preferences', { token })
      .then((result) => {
        if (cancelled) return
        setPrefs(result)
        setScope({ events: result.events, monitorIds: result.monitorIds, tags: result.tags })
        setWebhook(webhookConfigFrom(result))
      })
      .catch((err) => { if (!cancelled) fail(err) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, token])

  async function run(work: () => Promise<void>) {
    setBusy(true)
    setNotice(null)
    try { await work() } catch (err) { fail(err) } finally { setBusy(false) }
  }

  const confirm = () => run(async () => {
    const result = await send<{ manageToken: string }>('POST', '/confirm', { token })
    setToken(result.manageToken)
    setNotice({ tone: 'ok', text: t('subscribe.confirmed') })
    setMode('manage')
  })

  const doUnsubscribe = () => run(async () => {
    await send('POST', '/unsubscribe', { token })
    setNotice({ tone: 'ok', text: t('subscribe.unsubscribed') })
    setPrefs((current) => (current ? { ...current, status: 'unsubscribed' } : current))
    setMode('manage')
  })

  const save = (resubscribe = false) => run(async () => {
    if (!scope) return
    const webhookFields = prefs?.type === 'webhook' && webhook
      ? { webhookMethod: webhook.method, webhookHeaders: cleanHeaders(webhook.headers, prefs.webhookHeaderNames), notifyOnFailure: webhook.notifyOnFailure }
      : {}
    const result = await send<SubscriptionPreferences>('PUT', '/preferences', { token, ...scope, ...webhookFields, resubscribe })
    setPrefs(result)
    setWebhook(webhookConfigFrom(result))
    setNotice({ tone: 'ok', text: resubscribe ? t('subscribe.confirmed') : t('subscribe.saved') })
  })

  const title = mode === 'confirm' ? t('subscribe.confirmTitle') : mode === 'unsubscribe' ? t('subscribe.unsubscribeTitle') : t('subscribe.manageTitle')

  return (
    <Dialog title={title} onClose={onClose}>
      <div className="space-y-5">
        {invalid ? (
          <Notice tone="error">{t('subscribe.invalidLink')}</Notice>
        ) : mode === 'confirm' ? (
          <div className="flex justify-end">
            <PrimaryButton disabled={busy} onClick={confirm}>{t('subscribe.confirmButton')}</PrimaryButton>
          </div>
        ) : mode === 'unsubscribe' ? (
          <div className="flex justify-end gap-2">
            <SecondaryButton onClick={() => setMode('manage')}>{t('subscribe.manage')}</SecondaryButton>
            <PrimaryButton disabled={busy} onClick={doUnsubscribe}>{t('subscribe.unsubscribe')}</PrimaryButton>
          </div>
        ) : prefs && scope && options ? (
          <>
            <p className="text-sm" style={{ color: 'var(--bsp-text-muted)' }}>
              {prefs.type === 'webhook' ? prefs.webhookUrl : prefs.email}
            </p>
            {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
            {prefs.status === 'disabled' && !notice && <Notice tone="error">{t('subscribe.paused')}</Notice>}
            <ScopeFields options={options} scope={scope} onChange={setScope} />
            {prefs.type === 'webhook' && webhook && (
              <WebhookOptions config={webhook} onChange={setWebhook} savedHeaderNames={prefs.webhookHeaderNames} />
            )}
            {prefs.status === 'unsubscribed' || prefs.status === 'disabled' ? (
              <div className="flex justify-end">
                <PrimaryButton disabled={busy || !scopeIsValid(scope)} onClick={() => save(true)}>
                  {t(prefs.status === 'disabled' ? 'subscribe.resume' : 'subscribe.resubscribe')}
                </PrimaryButton>
              </div>
            ) : (
              <div className="flex justify-between gap-2">
                <SecondaryButton danger onClick={doUnsubscribe}>{t('subscribe.unsubscribe')}</SecondaryButton>
                <PrimaryButton disabled={busy || !scopeIsValid(scope)} onClick={() => save()}>{t('subscribe.save')}</PrimaryButton>
              </div>
            )}
          </>
        ) : null}
        {notice && mode !== 'manage' && <Notice tone={notice.tone}>{notice.text}</Notice>}
      </div>
    </Dialog>
  )
}
