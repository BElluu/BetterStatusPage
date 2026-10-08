import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { deliveryHistoryUrl } from '../deliveryHistoryUrl'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SUBSCRIBER_EVENT_TYPES, SUBSCRIPTION_METHODS, subscriptionMethodStatuses } from '@bsp/shared'
import type {
  AdminSubscriptionSettings, Monitor, Subscriber, SubscriberEventType, SubscriberList, SubscriberStatus,
  SubscriptionMethod, SubscriptionMethodProblem, SubscriptionMethodStatus,
} from '@bsp/shared'
import { api } from '../api/client'
import { ConfirmModal } from '../components/ConfirmModal'
import { CopyButton } from '../components/CopyButton'
import { EmptyStateLink, EmptyTableRow, ErrorState, LoadingState, PageContainer, PageHeader, Pagination, Switch, useToast } from '../components/ui'
import { useDebouncedValue } from '../hooks/useDebouncedValue'

export const SUBSCRIBER_EVENT_LABELS: Record<SubscriberEventType, { label: string; hint: string }> = {
  'incident.created':      { label: 'New incidents',         hint: 'When an incident is published' },
  'incident.updated':      { label: 'Incident updates',      hint: 'Every update posted to an ongoing incident' },
  'incident.resolved':     { label: 'Resolutions',           hint: 'When an incident is marked resolved' },
  'maintenance.scheduled': { label: 'Scheduled maintenance', hint: 'When a maintenance window is announced' },
}

const STATUS_STYLE: Record<SubscriberStatus, { bg: string; fg: string; label: string }> = {
  active:       { bg: 'var(--m3-up-bg)', fg: 'var(--m3-up)', label: 'Active' },
  pending:      { bg: 'var(--m3-degraded-bg)', fg: 'var(--m3-degraded)', label: 'Awaiting confirmation' },
  unsubscribed: { bg: 'var(--m3-surface-container-high)', fg: 'var(--m3-secondary)', label: 'Unsubscribed' },
  disabled:     { bg: 'var(--m3-down-bg)', fg: 'var(--m3-down)', label: 'Paused — endpoint failing' },
}

type Filter = 'all' | SubscriberStatus
type Tab = 'subscribers' | 'settings'
type SettingsDraft = Omit<AdminSubscriptionSettings, 'updatedAt' | 'smtpConfigured' | 'publicUrl' | 'statusPagePrivate' | 'methods'>
type MethodToggle = 'allowEmail' | 'allowWebhook' | 'allowSlack' | 'rssEnabled' | 'apiEnabled'

const cardStyle = { background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }
const panelStyle = { background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)' }

const METHOD_CONFIG: Record<SubscriptionMethod, { title: string; icon: string; toggle: MethodToggle; description: string }> = {
  email: {
    title: 'Email', icon: 'mail', toggle: 'allowEmail',
    description: 'Visitors enter their address and confirm it with a link (double opt-in). Every email carries a manage link and one-click unsubscribe.',
  },
  webhook: {
    title: 'Webhook', icon: 'webhook', toggle: 'allowWebhook',
    description: 'Visitors register an https URL that receives JSON, optionally with their own HTTP method and headers. They confirm by email and can be emailed when the URL stops responding; after 5 failed deliveries in a row it is paused. Private and internal addresses are refused.',
  },
  slack: {
    title: 'Slack', icon: 'forum', toggle: 'allowSlack',
    description: "Visitors paste a /feed subscribe command into a Slack channel and Slack's RSS app posts each allowed event. Slack polls the feed, so posts can lag by several minutes, and the page must be reachable from the internet.",
  },
  rss: {
    title: 'RSS / Atom', icon: 'rss_feed', toggle: 'rssEnabled',
    description: 'Public incident feeds for feed readers. No signup; they mirror what the public page shows.',
  },
  api: {
    title: 'Status API', icon: 'data_object', toggle: 'apiEnabled',
    description: "Read-only JSON (summary.json, components.json) for other teams' dashboards and scripts. No key needed; only components on the public page are included.",
  },
}

function subscribersQuery(filter: Filter, search: string, page: number) {
  const params = new URLSearchParams({ page: String(page), limit: '25' })
  if (filter !== 'all') params.set('status', filter)
  if (search) params.set('search', search)
  return {
    queryKey: ['subscribers', filter, search, page],
    queryFn: () => api.get<SubscriberList>(`/admin/subscribers?${params.toString()}`),
  }
}

export default function SubscribersPage() {
  const [tab, setTab] = useState<Tab>('subscribers')
  const { data: settings, isLoading, isError, refetch } = useQuery<AdminSubscriptionSettings>({
    queryKey: ['subscription-settings'],
    queryFn: () => api.get('/admin/subscribers/settings'),
  })
  // Same key as the table's unfiltered first page, so the tab count costs no extra request.
  const { data: overview } = useQuery(subscribersQuery('all', '', 1))

  const tabs: Array<{ key: Tab; label: string; count?: number | undefined }> = [
    { key: 'subscribers', label: 'Subscribers', count: overview?.stats.total },
    { key: 'settings', label: 'Settings' },
  ]

  return (
    <PageContainer>
      <PageHeader
        title="Subscribers"
        subtitle="Choose how visitors of the status page can follow incidents and maintenance"
        actions={
          <Link to={deliveryHistoryUrl('subscribers')} className="btn btn-secondary">
            <span className="material-symbols-outlined" aria-hidden="true">history</span>
            Delivery history
          </Link>
        }
      >
        <div role="tablist" aria-label="Subscribers sections" className="flex gap-6" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
          {tabs.map((item) => {
            const active = tab === item.key
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                id={`subscribers-tab-${item.key}`}
                aria-selected={active}
                aria-controls={`subscribers-panel-${item.key}`}
                onClick={() => setTab(item.key)}
                className="inline-flex items-center gap-2 px-0.5 pb-3 -mb-px text-sm font-semibold focus-ring"
                style={{ borderBottom: `2px solid ${active ? 'var(--m3-on-surface)' : 'transparent'}`, color: active ? 'var(--m3-on-surface)' : 'var(--m3-secondary)' }}
              >
                {item.label}
                {item.count !== undefined && (
                  <span className="font-mono text-xs px-1.5 rounded-full" style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-secondary)' }}>{item.count}</span>
                )}
              </button>
            )
          })}
        </div>
      </PageHeader>

      {/* Both panels stay mounted so unsaved settings and a selection survive a tab switch. */}
      <div role="tabpanel" id="subscribers-panel-subscribers" aria-labelledby="subscribers-tab-subscribers" hidden={tab !== 'subscribers'}>
        <SubscriberTable />
      </div>
      <div role="tabpanel" id="subscribers-panel-settings" aria-labelledby="subscribers-tab-settings" hidden={tab !== 'settings'}>
        {isLoading && <LoadingState label="Loading subscription settings…" />}
        {isError && <ErrorState message="Could not load subscription settings." onRetry={() => void refetch()} />}
        {settings && <SettingsPanel settings={settings} />}
      </div>
    </PageContainer>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-xs uppercase tracking-wider mb-3" style={{ color: 'var(--m3-secondary)' }}>{children}</p>
}

function ProblemText({ problem }: { problem: SubscriptionMethodProblem }) {
  switch (problem) {
    case 'disabled': return <>Turn on <strong>Allow visitors to subscribe</strong> above.</>
    case 'smtp': return <>SMTP is not configured — set it up in <Link to="/admin/notifications" className="underline">Notifications → SMTP Settings</Link>.</>
    case 'publicUrl': return <>Set <code>PUBLIC_URL</code> in the server environment and restart — confirmation links point to it.</>
    case 'events': return <>Allow at least one notification type below.</>
    case 'private': return <>The status page is private, and feed readers, Slack and scripts cannot sign in. Make it public in <Link to="/admin/users" className="underline">Users → Status page access</Link>.</>
  }
}

function MethodRow({ method, status, onToggle, feedBase }: {
  method: SubscriptionMethod
  status: SubscriptionMethodStatus
  onToggle: (on: boolean) => void
  feedBase: string
}) {
  const config = METHOD_CONFIG[method]
  const badge = !status.enabled
    ? { label: 'Off', bg: 'var(--m3-surface-container-high)', fg: 'var(--m3-secondary)' }
    : status.available
      ? { label: 'Offered to visitors', bg: 'var(--m3-up-bg)', fg: 'var(--m3-up)' }
      : { label: 'Not available', bg: 'var(--m3-degraded-bg)', fg: 'var(--m3-degraded)' }
  const urls = method === 'slack' ? [`/feed subscribe ${feedBase}/api/v1/public/slack.rss`]
    : method === 'rss' ? [`${feedBase}/api/v1/public/incidents.rss`, `${feedBase}/api/v1/public/incidents.atom`]
    : method === 'api' ? [`${feedBase}/api/v1/public/summary.json`, `${feedBase}/api/v1/public/components.json`]
    : []

  return (
    <div data-testid={`method-${method}`} className="grid grid-cols-[36px_minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 px-4 sm:px-6 py-4" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
      <span className="w-9 h-9 rounded-[10px] flex items-center justify-center" style={{ background: 'var(--admin-icon-container)', color: 'var(--admin-icon-color)' }}>
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '20px' }}>{config.icon}</span>
      </span>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2 min-h-5">
          <span className="font-headline font-semibold text-sm" style={{ color: 'var(--m3-on-surface)' }}>{config.title}</span>
          <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: badge.bg, color: badge.fg }}>{badge.label}</span>
        </div>
        <p className="text-xs max-w-[720px]" style={{ color: 'var(--m3-secondary)' }}>{config.description}</p>
        {status.enabled && status.problems.length > 0 && (
          <ul className="text-xs space-y-1 pt-1.5" style={{ color: 'var(--m3-on-surface-variant)' }}>
            {status.problems.map((problem) => (
              <li key={problem} className="flex gap-1.5">
                <span className="material-symbols-outlined flex-shrink-0" aria-hidden="true" style={{ fontSize: '14px', color: 'var(--m3-degraded)', marginTop: '1px' }}>warning</span>
                <span><ProblemText problem={problem} /></span>
              </li>
            ))}
          </ul>
        )}
        {status.enabled && urls.length > 0 && (
          <div className="pt-1.5 space-y-1.5">
            {urls.map((url) => (
              <div key={url} className="flex items-center gap-2 max-w-[640px] py-1 pl-2.5 pr-1 rounded-lg font-mono text-xs" style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-on-surface-variant)' }}>
                <span className="flex-1 min-w-0 truncate" title={url}>{url}</span>
                <CopyButton value={url} />
              </div>
            ))}
          </div>
        )}
      </div>
      <Switch checked={status.enabled} onChange={onToggle} aria-label={`Enable ${config.title}`} />
    </div>
  )
}

function SettingsPanel({ settings }: { settings: AdminSubscriptionSettings }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<SettingsDraft>(() => pick(settings))
  const [message, setMessage] = useState('')
  useEffect(() => { setDraft(pick(settings)) }, [settings])

  const save = useMutation({
    mutationFn: (values: SettingsDraft) => api.put<AdminSubscriptionSettings>('/admin/subscribers/settings', values),
    onSuccess: (saved) => {
      qc.setQueryData(['subscription-settings'], saved)
      setMessage('Saved — the status page picks it up on its next load')
    },
    onError: (error: Error) => setMessage(error.message),
  })

  const set = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => {
    setMessage('')
    setDraft((current) => ({ ...current, [key]: value }))
  }
  const toggleEvent = (type: SubscriberEventType, on: boolean) =>
    set('allowedEvents', SUBSCRIBER_EVENT_TYPES.filter((t) => (t === type ? on : draft.allowedEvents.includes(t))))
  const discard = () => {
    setMessage('')
    setDraft(pick(settings))
  }

  const publicUrl = settings.publicUrl
  const feedBase = publicUrl || window.location.origin
  // Same rule the server applies, evaluated on the unsaved draft so every change shows its effect.
  const statuses = subscriptionMethodStatuses(draft, { smtpConfigured: settings.smtpConfigured, publicUrl, statusPagePrivate: settings.statusPagePrivate })
  const offered = SUBSCRIPTION_METHODS.filter((method) => statuses[method].available)
  const dirty = JSON.stringify(draft) !== JSON.stringify(pick(settings))
  const offeredText = !draft.enabled ? 'Off — the Subscribe button is hidden and subscribers receive nothing.'
    : offered.length ? `Visitors choose from: ${offered.map((m) => METHOD_CONFIG[m].title).join(', ')}`
    : 'No method is available yet, so the Subscribe button stays hidden.'
  const barText = message && (save.isError || !dirty) ? message : 'You have unsaved changes'

  return (
    <div className="space-y-4 max-w-[1080px] pb-[88px]">
      <section className="rounded-xl py-2.5 pl-4 pr-3" style={panelStyle}>
        <Switch
          label="Allow visitors to subscribe"
          description={<span style={{ color: draft.enabled && !offered.length ? 'var(--m3-degraded)' : undefined }}>{offeredText}</span>}
          checked={draft.enabled}
          onChange={(v) => set('enabled', v)}
        />
      </section>

      <section className="rounded-2xl overflow-hidden" style={panelStyle}>
        <div className="px-4 sm:px-6 py-4"><SectionLabel>Subscription methods</SectionLabel></div>
        {SUBSCRIPTION_METHODS.map((method) => (
          <MethodRow
            key={method}
            method={method}
            status={statuses[method]}
            onToggle={(on) => set(METHOD_CONFIG[method].toggle, on)}
            feedBase={feedBase}
          />
        ))}
      </section>

      <section className="rounded-2xl p-6 grid gap-8 lg:grid-cols-2" style={panelStyle}>
        <div>
          <SectionLabel>Notifications subscribers may receive</SectionLabel>
          <div className="space-y-2.5">
            {SUBSCRIBER_EVENT_TYPES.map((type) => (
              <label key={type} className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1"
                  style={{ accentColor: 'var(--admin-control-accent)' }}
                  checked={draft.allowedEvents.includes(type)}
                  onChange={(e) => toggleEvent(type, e.target.checked)}
                />
                <span>
                  <span className="block text-sm font-medium" style={{ color: 'var(--m3-on-surface)' }}>{SUBSCRIBER_EVENT_LABELS[type].label}</span>
                  <span className="block text-xs" style={{ color: 'var(--m3-secondary)' }}>{SUBSCRIBER_EVENT_LABELS[type].hint}</span>
                </span>
              </label>
            ))}
            <p className="text-xs pt-1" style={{ color: 'var(--m3-secondary)' }}>
              Applies to email, webhook and Slack. Subscribers pick from these; monitor status flaps are never sent — only what you publish.
            </p>
          </div>
        </div>

        <div>
          <SectionLabel>Scope</SectionLabel>
          <Switch
            label="Let subscribers choose components"
            description="Email and webhook subscribers can follow only selected monitors or tags. Only monitors placed on the public page are offered. Incidents with no linked monitors go to everyone."
            checked={draft.allowComponentScope}
            onChange={(v) => set('allowComponentScope', v)}
          />
        </div>
      </section>

      {(dirty || message) && (
        <div className="sticky bottom-6 -mt-[72px] flex justify-center pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-4 py-2.5 pl-5 pr-2.5 rounded-2xl" style={{ ...panelStyle, boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
            <span role={save.isError ? 'alert' : 'status'} className="text-sm" style={{ color: save.isError && message ? 'var(--m3-down)' : 'var(--m3-on-surface)' }}>{barText}</span>
            {dirty && (
              <div className="flex gap-2">
                <button type="button" onClick={discard} disabled={save.isPending} className="btn btn-ghost">Discard</button>
                <button type="button" onClick={() => save.mutate(draft)} disabled={save.isPending} className="btn btn-primary">
                  {save.isPending ? 'Saving…' : 'Save settings'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** The editable subset of the server settings, in the same key order as the draft. */
function pick(settings: SettingsDraft): SettingsDraft {
  const { enabled, allowEmail, allowWebhook, allowSlack, allowedEvents, allowComponentScope, rssEnabled, apiEnabled } = settings
  return { enabled, allowEmail, allowWebhook, allowSlack, allowedEvents, allowComponentScope, rssEnabled, apiEnabled }
}

const destination = (s: Subscriber) => (s.type === 'webhook' ? s.webhookUrl : s.email) ?? ''

function SubscriberTable() {
  const qc = useQueryClient()
  const toast = useToast()
  const [filter, setFilter] = useState<Filter>('all')
  const [searchInput, setSearchInput] = useState('')
  const [search] = useDebouncedValue(searchInput, 300)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [confirmDelete, setConfirmDelete] = useState<Subscriber[] | null>(null)

  const term = search.trim()
  const { data, isLoading, isError, refetch } = useQuery<SubscriberList>(subscribersQuery(filter, term, page))
  const { data: monitors = [] } = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
  })

  const remove = useMutation({
    mutationFn: async (ids: number[]) => {
      const results = await Promise.allSettled(ids.map((id) => api.delete(`/admin/subscribers/${id}`)))
      const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      return { ids, deleted: ids.length - failed.length, failed: failed.length, reason: failed[0]?.reason as unknown }
    },
    onSuccess: ({ ids, deleted, failed, reason }) => {
      setConfirmDelete(null)
      setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))))
      qc.invalidateQueries({ queryKey: ['subscribers'] })
      if (failed === 0) toast.success(deleted === 1 ? 'Subscriber deleted.' : `${deleted} subscribers deleted.`)
      else if (deleted === 0) toast.error(reason instanceof Error && reason.message ? reason.message : 'Failed to delete subscriber')
      else toast.error(`${deleted} deleted, ${failed} failed.`)
    },
  })

  function exportCsv(ids?: number[]) {
    const params = new URLSearchParams()
    if (ids) params.set('ids', ids.join(','))
    else {
      if (filter !== 'all') params.set('status', filter)
      if (term) params.set('search', term)
    }
    api.download(`/admin/subscribers/export?${params.toString()}`, ids ? 'subscribers-selected.csv' : 'subscribers.csv')
      .catch(() => toast.error('Export failed'))
  }

  const showView = (next: { filter?: Filter; search?: string }) => {
    if (next.filter !== undefined) setFilter(next.filter)
    if (next.search !== undefined) setSearchInput(next.search)
    setPage(1)
    setSelected(new Set())
  }

  const stats = data?.stats
  const tabs: Array<{ key: Filter; label: string; count: number | undefined }> = [
    { key: 'all', label: 'All', count: stats?.total },
    { key: 'active', label: 'Active', count: stats?.active },
    { key: 'pending', label: 'Pending', count: stats?.pending },
    { key: 'unsubscribed', label: 'Unsubscribed', count: stats?.unsubscribed },
    { key: 'disabled', label: 'Paused', count: stats?.disabled },
  ]
  const rows = data?.subscribers ?? []
  const allSelected = rows.length > 0 && rows.every((s) => selected.has(s.id))
  const toggle = (id: number) => setSelected((current) => {
    const next = new Set(current)
    if (!next.delete(id)) next.add(id)
    return next
  })

  function scopeLabel(s: Subscriber): string {
    if (s.monitorIds.length === 0 && s.tags.length === 0) return 'All components'
    const names = s.monitorIds.map((id) => monitors.find((m) => m.id === id)?.name ?? `#${id}`)
    return [...names, ...s.tags.map((tag) => `#${tag}`)].join(', ')
  }

  return (
    <section className="space-y-4">
      {selected.size === 0 ? (
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 min-h-11">
          <div role="group" aria-label="Filter by status" className="flex max-w-full overflow-x-auto rounded-xl w-fit" style={{ border: '1px solid var(--m3-outline-variant)' }}>
            {tabs.map((tab) => {
              const active = filter === tab.key
              return (
                <button
                  key={tab.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => showView({ filter: tab.key })}
                  className={`px-4 py-2 text-sm font-semibold whitespace-nowrap transition-colors focus-ring ${active ? 'selection-active' : ''}`}
                  style={{ background: 'transparent', color: 'var(--m3-secondary)' }}
                >
                  {tab.label}{tab.count !== undefined && <span className="ml-1.5 font-mono text-xs opacity-70">{tab.count}</span>}
                </button>
              )
            })}
          </div>
          <div className="flex items-center gap-2 md:justify-end md:flex-1">
            <input
              value={searchInput}
              onChange={(e) => showView({ search: e.target.value })}
              placeholder="Search email or URL…"
              aria-label="Search subscribers"
              type="search"
              className="input-sig md:max-w-xs"
            />
            <button type="button" onClick={() => exportCsv()} className="btn btn-outline whitespace-nowrap">
              <span className="material-symbols-outlined" aria-hidden="true">download</span>
              Export CSV
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 min-h-11 py-1.5 pl-4 pr-2 rounded-xl selection-active" style={{ border: '1px solid var(--admin-selection-border)' }}>
          <div className="flex items-center gap-3 text-sm">
            <span className="font-semibold">{selected.size} selected</span>
            <button type="button" onClick={() => setSelected(new Set())} className="underline focus-ring rounded">Clear</button>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => exportCsv([...selected])} className="btn btn-outline btn-sm">
              <span className="material-symbols-outlined" aria-hidden="true">download</span>
              Export selected
            </button>
            <button type="button" onClick={() => setConfirmDelete(rows.filter((s) => selected.has(s.id)))} className="btn btn-danger-outline btn-sm">
              <span className="material-symbols-outlined" aria-hidden="true">delete</span>
              Delete
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <LoadingState label="Loading subscribers…" />
      ) : isError || !data ? (
        <ErrorState message="Could not load subscribers." onRetry={() => void refetch()} />
      ) : (
        <div className="rounded-2xl overflow-x-auto" style={cardStyle}>
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
                <th className="w-11 pl-4 py-3 text-left" style={{ background: 'var(--m3-surface-container)' }}>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allSelected}
                    disabled={rows.length === 0}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((s) => s.id)))}
                    style={{ accentColor: 'var(--admin-control-accent)', width: '16px', height: '16px' }}
                  />
                </th>
                {['Destination', 'Status', 'Receives', 'Scope', 'Last notified', ''].map((h) => (
                  <th key={h} className={`px-4 py-3 font-mono text-xs uppercase tracking-wider ${h === '' ? 'text-right' : 'text-left'}`}
                    style={{ color: 'var(--m3-secondary)', background: 'var(--m3-surface-container)' }}>{h === '' ? <span className="sr-only">Actions</span> : h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((s, i) => {
                const style = STATUS_STYLE[s.status]
                const checked = selected.has(s.id)
                return (
                  <tr key={s.id} style={{ borderTop: i > 0 ? '1px solid var(--m3-outline-variant)' : 'none', background: checked ? 'color-mix(in srgb, var(--admin-selection) 55%, transparent)' : undefined }}>
                    <td className="pl-4 py-3.5 align-top">
                      <input
                        type="checkbox"
                        aria-label={`Select ${destination(s)}`}
                        checked={checked}
                        onChange={() => toggle(s.id)}
                        style={{ accentColor: 'var(--admin-control-accent)', width: '16px', height: '16px', marginTop: '2px' }}
                      />
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px', color: 'var(--m3-secondary)' }}>
                          {s.type === 'webhook' ? 'webhook' : 'mail'}
                        </span>
                        <span className="font-medium break-all" style={{ color: 'var(--m3-on-surface)' }}>{destination(s)}</span>
                      </div>
                      {s.type === 'webhook' && (
                        <div className="text-xs mt-0.5 ml-6 space-y-0.5" style={{ color: 'var(--m3-secondary)' }}>
                          <div>Contact: {s.email}{s.notifyOnFailure ? ' · failure alerts on' : ''}</div>
                          <div className="font-mono">
                            {s.webhookMethod}
                            {s.webhookHeaderNames.length > 0 && ` · ${s.webhookHeaderNames.join(', ')}`}
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap" style={{ background: style.bg, color: style.fg }}>{style.label}</span>
                    </td>
                    <td className="px-4 py-3 align-top text-xs" style={{ color: 'var(--m3-on-surface-variant)' }}>
                      {s.events.length === SUBSCRIBER_EVENT_TYPES.length ? 'Everything' : s.events.map((e) => SUBSCRIBER_EVENT_LABELS[e].label).join(', ')}
                    </td>
                    <td className="px-4 py-3 align-top text-xs" style={{ color: 'var(--m3-on-surface-variant)' }}>{scopeLabel(s)}</td>
                    <td className="px-4 py-3 align-top text-xs" style={{ color: 'var(--m3-secondary)' }}>
                      {s.lastNotifiedAt ? new Date(s.lastNotifiedAt).toLocaleString() : '—'}
                      {s.lastError && (
                        <div className="mt-0.5" style={{ color: 'var(--m3-down)' }} title={s.lastError}>
                          {s.consecutiveFailures > 0 ? `${s.consecutiveFailures} failed in a row` : 'Last attempt failed'}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-4 pl-0 align-top text-right whitespace-nowrap">
                      <Link
                        to={deliveryHistoryUrl('subscribers', s.id)}
                        aria-label={`Delivery history for ${destination(s)}`}
                        title="Delivery history"
                        className="btn-icon"
                      >
                        <span className="material-symbols-outlined" aria-hidden="true">history</span>
                      </Link>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete([s])}
                        aria-label={`Delete ${destination(s)}`}
                        title="Delete"
                        className="btn-icon"
                      >
                        <span className="material-symbols-outlined" aria-hidden="true">delete</span>
                      </button>
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (filter !== 'all' || term
                ? <EmptyTableRow
                    colSpan={7}
                    icon="group_off"
                    title="No subscribers match this filter"
                    description={<>Try another status or search term, or <EmptyStateLink onClick={() => showView({ filter: 'all', search: '' })}>show all subscribers</EmptyStateLink>.</>}
                  />
                : <EmptyTableRow colSpan={7} icon="group_off" title="No subscribers yet" description="People who subscribe on the status page will appear here." />)}
            </tbody>
          </table>
        </div>
      )}

      {data && (
        <Pagination
          page={page}
          pageCount={data.pages}
          onPageChange={(next) => { setPage(next); setSelected(new Set()) }}
          summary={`Page ${page} of ${data.pages} · ${data.total} subscribers`}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title={confirmDelete.length === 1 ? 'Delete subscriber' : `Delete ${confirmDelete.length} subscribers`}
          message={`Delete ${confirmDelete.length === 1 ? destination(confirmDelete[0]!) : `${confirmDelete.length} subscribers`}? They stop receiving notifications immediately and their data is removed.`}
          pending={remove.isPending}
          pendingLabel="Deleting…"
          onConfirm={() => remove.mutate(confirmDelete.map((s) => s.id))}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </section>
  )
}
