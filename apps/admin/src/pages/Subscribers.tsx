import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SUBSCRIBER_EVENT_TYPES, SUBSCRIPTION_METHODS, subscriptionMethodStatuses } from '@bsp/shared'
import type {
  AdminSubscriptionSettings, Monitor, Subscriber, SubscriberEventType, SubscriberList, SubscriberStatus,
  SubscriptionMethod, SubscriptionMethodProblem, SubscriptionMethodStatus,
} from '@bsp/shared'
import { api } from '../api/client'
import { ConfirmModal } from '../components/ConfirmModal'
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
type SettingsDraft = Omit<AdminSubscriptionSettings, 'updatedAt' | 'smtpConfigured' | 'publicUrl' | 'methods'>
type MethodToggle = 'allowEmail' | 'allowWebhook' | 'allowSlack' | 'rssEnabled' | 'apiEnabled'

const cardStyle = { background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }

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

export default function SubscribersPage() {
  const { data: settings, isLoading, isError, refetch } = useQuery<AdminSubscriptionSettings>({
    queryKey: ['subscription-settings'],
    queryFn: () => api.get('/admin/subscribers/settings'),
  })

  return (
    <PageContainer>
      <PageHeader title="Subscribers" subtitle="Choose how visitors of the status page can follow incidents and maintenance" />
      {isLoading && <LoadingState label="Loading subscription settings…" />}
      {isError && <ErrorState message="Could not load subscription settings." onRetry={() => void refetch()} />}
      {settings && <SettingsCard settings={settings} />}
      <SubscriberTable />
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
  }
}

function MethodCard({ method, status, onToggle, feedBase }: {
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
    <div data-testid={`method-${method}`} className="rounded-xl p-4 space-y-3" style={{ background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '20px', color: 'var(--m3-secondary)' }}>{config.icon}</span>
          <span className="font-headline font-semibold text-sm" style={{ color: 'var(--m3-on-surface)' }}>{config.title}</span>
          <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: badge.bg, color: badge.fg }}>{badge.label}</span>
        </div>
        <Switch checked={status.enabled} onChange={onToggle} aria-label={`Enable ${config.title}`} />
      </div>
      <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>{config.description}</p>
      {status.enabled && status.problems.length > 0 && (
        <ul className="text-xs space-y-1 rounded-lg px-3 py-2" style={{ background: 'var(--m3-degraded-bg)', color: 'var(--m3-on-surface-variant)' }}>
          {status.problems.map((problem) => (
            <li key={problem} className="flex gap-1.5">
              <span className="material-symbols-outlined flex-shrink-0" aria-hidden="true" style={{ fontSize: '14px', color: 'var(--m3-degraded)', marginTop: '1px' }}>warning</span>
              <span><ProblemText problem={problem} /></span>
            </li>
          ))}
        </ul>
      )}
      {status.enabled && urls.length > 0 && (
        <div className="text-xs space-y-1 font-mono break-all" style={{ color: 'var(--m3-secondary)' }}>
          {urls.map((url) => <div key={url}>{url}</div>)}
        </div>
      )}
    </div>
  )
}

function SettingsCard({ settings }: { settings: AdminSubscriptionSettings }) {
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

  const publicUrl = settings.publicUrl
  const feedBase = publicUrl || window.location.origin
  // Same rule the server applies, evaluated on the unsaved draft so every change shows its effect.
  const statuses = subscriptionMethodStatuses(draft, { smtpConfigured: settings.smtpConfigured, publicUrl })
  const offered = SUBSCRIPTION_METHODS.filter((method) => statuses[method].available)
  const dirty = JSON.stringify(draft) !== JSON.stringify(pick(settings))

  return (
    <section className="rounded-2xl p-6 space-y-6" style={cardStyle}>
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div className="space-y-2 md:max-w-2xl">
          <Switch
            label="Allow visitors to subscribe"
            description="Master switch. Off hides the Subscribe button, takes the feeds and the status API offline, and stops notifications to subscribers."
            checked={draft.enabled}
            onChange={(v) => set('enabled', v)}
          />
          {draft.enabled && (
            <p className="text-xs" style={{ color: offered.length ? 'var(--m3-secondary)' : 'var(--m3-degraded)' }}>
              {offered.length
                ? `Visitors will choose from: ${offered.map((m) => METHOD_CONFIG[m].title).join(', ')}.`
                : 'No method is available yet, so the Subscribe button stays hidden.'}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {message && <span role={save.isError ? 'alert' : 'status'} className="text-xs" style={{ color: save.isError ? 'var(--m3-down)' : 'var(--m3-up)' }}>{message}</span>}
          <button
            type="button"
            onClick={() => save.mutate(draft)}
            disabled={save.isPending || !dirty}
            className="btn btn-primary"
          >
            {save.isPending ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </div>

      <div>
        <SectionLabel>Subscription methods</SectionLabel>
        <div className="grid gap-3 lg:grid-cols-2">
          {SUBSCRIPTION_METHODS.map((method) => (
            <MethodCard
              key={method}
              method={method}
              status={statuses[method]}
              onToggle={(on) => set(METHOD_CONFIG[method].toggle, on)}
              feedBase={feedBase}
            />
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionLabel>Notifications subscribers may receive</SectionLabel>
          <div className="space-y-2.5">
            {SUBSCRIBER_EVENT_TYPES.map((type) => (
              <label key={type} className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1"
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
      </div>
    </section>
  )
}

/** The editable subset of the server settings, in the same key order as the draft. */
function pick(settings: SettingsDraft): SettingsDraft {
  const { enabled, allowEmail, allowWebhook, allowSlack, allowedEvents, allowComponentScope, rssEnabled, apiEnabled } = settings
  return { enabled, allowEmail, allowWebhook, allowSlack, allowedEvents, allowComponentScope, rssEnabled, apiEnabled }
}

function SubscriberTable() {
  const qc = useQueryClient()
  const toast = useToast()
  const [filter, setFilter] = useState<Filter>('all')
  const [searchInput, setSearchInput] = useState('')
  const [search] = useDebouncedValue(searchInput, 300)
  const [page, setPage] = useState(1)
  const [confirmDelete, setConfirmDelete] = useState<Subscriber | null>(null)

  const params = new URLSearchParams({ page: String(page), limit: '25' })
  if (filter !== 'all') params.set('status', filter)
  if (search.trim()) params.set('search', search.trim())

  const { data, isLoading, isError, refetch } = useQuery<SubscriberList>({
    queryKey: ['subscribers', filter, search.trim(), page],
    queryFn: () => api.get(`/admin/subscribers?${params.toString()}`),
  })
  const { data: monitors = [] } = useQuery<Monitor[]>({
    queryKey: ['monitors'],
    queryFn: () => api.get('/admin/monitors'),
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/subscribers/${id}`),
    onSuccess: () => {
      toast.success('Subscriber deleted.')
      setConfirmDelete(null)
      qc.invalidateQueries({ queryKey: ['subscribers'] })
    },
    onError: (err) => {
      setConfirmDelete(null)
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to delete subscriber')
    },
  })

  const destination = (s: Subscriber) => (s.type === 'webhook' ? s.webhookUrl : s.email) ?? ''

  const stats = data?.stats
  const tabs: Array<{ key: Filter; label: string; count: number | undefined }> = [
    { key: 'all', label: 'All', count: stats?.total },
    { key: 'active', label: 'Active', count: stats?.active },
    { key: 'pending', label: 'Pending', count: stats?.pending },
    { key: 'unsubscribed', label: 'Unsubscribed', count: stats?.unsubscribed },
    { key: 'disabled', label: 'Paused', count: stats?.disabled },
  ]

  function scopeLabel(s: Subscriber): string {
    if (s.monitorIds.length === 0 && s.tags.length === 0) return 'All components'
    const names = s.monitorIds.map((id) => monitors.find((m) => m.id === id)?.name ?? `#${id}`)
    return [...names, ...s.tags.map((tag) => `#${tag}`)].join(', ')
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div role="group" aria-label="Filter by status" className="flex max-w-full overflow-x-auto rounded-xl w-fit" style={{ border: '1px solid var(--m3-outline-variant)' }}>
          {tabs.map((tab) => {
            const active = filter === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                aria-pressed={active}
                onClick={() => { setFilter(tab.key); setPage(1) }}
                className={`px-4 py-2 text-sm font-semibold whitespace-nowrap transition-colors focus-ring ${active ? 'selection-active' : ''}`}
                style={{ background: 'transparent', color: 'var(--m3-secondary)' }}
              >
                {tab.label}{tab.count !== undefined && <span className="ml-1.5 font-mono text-xs opacity-70">{tab.count}</span>}
              </button>
            )
          })}
        </div>
        <input
          value={searchInput}
          onChange={(e) => { setSearchInput(e.target.value); setPage(1) }}
          placeholder="Search email or URL…"
          aria-label="Search subscribers"
          type="search"
          className="input-sig md:max-w-xs"
        />
      </div>

      {isLoading ? (
        <LoadingState label="Loading subscribers…" />
      ) : isError || !data ? (
        <ErrorState message="Could not load subscribers." onRetry={() => void refetch()} />
      ) : (
        <div className="rounded-2xl overflow-x-auto" style={cardStyle}>
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
                {['Destination', 'Status', 'Receives', 'Scope', 'Last notified', ''].map((h) => (
                  <th key={h} className={`px-4 py-3 font-mono text-xs uppercase tracking-wider ${h === '' ? 'text-right' : 'text-left'}`}
                    style={{ color: 'var(--m3-secondary)', background: 'var(--m3-surface-container)' }}>{h === '' ? <span className="sr-only">Actions</span> : h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.subscribers.map((s, i) => {
                const style = STATUS_STYLE[s.status]
                return (
                  <tr key={s.id} style={{ borderTop: i > 0 ? '1px solid var(--m3-outline-variant)' : 'none' }}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px', color: 'var(--m3-secondary)' }}>
                          {s.type === 'webhook' ? 'webhook' : 'mail'}
                        </span>
                        <span className="font-medium break-all" style={{ color: 'var(--m3-on-surface)' }}>{s.type === 'webhook' ? s.webhookUrl : s.email}</span>
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
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap" style={{ background: style.bg, color: style.fg }}>{style.label}</span>
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--m3-on-surface-variant)' }}>
                      {s.events.length === SUBSCRIBER_EVENT_TYPES.length ? 'Everything' : s.events.map((e) => SUBSCRIBER_EVENT_LABELS[e].label).join(', ')}
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--m3-on-surface-variant)' }}>{scopeLabel(s)}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--m3-secondary)' }}>
                      {s.lastNotifiedAt ? new Date(s.lastNotifiedAt).toLocaleString() : '—'}
                      {s.lastError && (
                        <div className="mt-0.5" style={{ color: 'var(--m3-down)' }} title={s.lastError}>
                          {s.consecutiveFailures > 0 ? `${s.consecutiveFailures} failed in a row` : 'Last attempt failed'}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(s)}
                        aria-label={`Delete ${destination(s)}`}
                        className="btn btn-danger-outline btn-sm"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                )
              })}
              {data.subscribers.length === 0 && (filter !== 'all' || search
                ? <EmptyTableRow
                    colSpan={6}
                    icon="group_off"
                    title="No subscribers match this filter"
                    description={<>Try another status or search term, or <EmptyStateLink onClick={() => { setFilter('all'); setSearchInput(''); setPage(1) }}>show all subscribers</EmptyStateLink>.</>}
                  />
                : <EmptyTableRow colSpan={6} icon="group_off" title="No subscribers yet" description="People who subscribe on the status page will appear here." />)}
            </tbody>
          </table>
        </div>
      )}

      {data && <Pagination page={page} pageCount={data.pages} onPageChange={setPage} />}

      {confirmDelete && (
        <ConfirmModal
          title="Delete subscriber"
          message={`Delete ${destination(confirmDelete)}? They stop receiving notifications immediately and their data is removed.`}
          pending={remove.isPending}
          pendingLabel="Deleting…"
          onConfirm={() => remove.mutate(confirmDelete.id)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </section>
  )
}
