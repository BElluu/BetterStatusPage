import { useEffect, useId, useState, type ReactElement } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { NotificationChannel, NotificationDelivery, NotificationDeliveryAttempt, SmtpSettings, VaultRef } from '@bsp/shared'
import ChannelFormModal from '../components/notifications/ChannelFormModal'
import { CHANNEL_TYPES, CHANNEL_TYPE_ORDER, type ChannelType } from '../components/notifications/channelTypes'
import { DiscordIcon, SlackIcon, TeamsIcon } from '../components/notifications/icons'
import { ConfirmModal } from '../components/ConfirmModal'
import { Link } from 'react-router-dom'
import { ModalHeader, ModalShell } from '../components/ModalShell'
import { Alert, EmptyStateLink, EmptyTableRow, ErrorState, Field, LoadingState, PageContainer, PageHeader, Pagination, QuickStartPanel, Switch, useToast, type FieldControlProps, type QuickStartOption } from '../components/ui'

const CHANNEL_QUICK_START: QuickStartOption<ChannelType>[] = CHANNEL_TYPE_ORDER.map((key) => ({
  key,
  label: CHANNEL_TYPES[key].label,
  hint: CHANNEL_TYPES[key].hint,
  icon: CHANNEL_TYPES[key].icon(18),
}))

export default function NotificationsPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const [editingChannel, setEditingChannel] = useState<NotificationChannel | null>(null)
  const [showCreate, setShowCreate]         = useState(false)
  const [createType, setCreateType]         = useState<ChannelType | undefined>(undefined)
  const [confirmDelete, setConfirmDelete]   = useState<NotificationChannel | null>(null)
  const [showSmtp, setShowSmtp]             = useState(false)

  const { data: channels = [], isLoading, isError, refetch } = useQuery<NotificationChannel[]>({
    queryKey: ['notification-channels'],
    queryFn: () => api.get('/admin/notifications/channels'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/notifications/channels/${id}`),
    onSuccess: () => {
      toast.success('Channel deleted.')
      setConfirmDelete(null)
      qc.invalidateQueries({ queryKey: ['notification-channels'] })
    },
    onError: (err) => {
      setConfirmDelete(null)
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to delete channel')
    },
  })

  function openCreate(type?: ChannelType) {
    setCreateType(type)
    setShowCreate(true)
  }

  function handleSaved() {
    toast.success(editingChannel ? 'Channel saved.' : 'Channel created.')
    qc.invalidateQueries({ queryKey: ['notification-channels'] })
    setEditingChannel(null)
    setShowCreate(false)
  }

  return (
    <PageContainer>
      <PageHeader
        title="Notifications"
        subtitle="Alert channels fired when a monitor changes status"
        actions={<>
          <Link to="/admin/notifications/history" className="btn btn-secondary">
            <span className="material-symbols-outlined" aria-hidden="true">history</span>
            Delivery history
          </Link>
          <button type="button" onClick={() => setShowSmtp(true)} className="btn btn-secondary">
            <span className="material-symbols-outlined" aria-hidden="true">forward_to_inbox</span>
            SMTP Settings
          </button>
          <button type="button" onClick={() => openCreate()} className="btn btn-primary">
            <span className="material-symbols-outlined" aria-hidden="true">add</span>
            Add Channel
          </button>
        </>}
      />

      <Alert tone="info">
        Create notification channels here, then assign them to individual monitors via the monitor&apos;s edit form.
        Use <code className="text-xs px-1 rounded" style={{ background: 'var(--m3-surface-container-highest)', fontFamily: 'monospace' }}>{'{{monitor_name}}'}</code>,{' '}
        <code className="text-xs px-1 rounded" style={{ background: 'var(--m3-surface-container-highest)', fontFamily: 'monospace' }}>{'{{status}}'}</code>,{' '}
        <code className="text-xs px-1 rounded" style={{ background: 'var(--m3-surface-container-highest)', fontFamily: 'monospace' }}>{'{{error_message}}'}</code> and more in message templates.
      </Alert>

      {/* Channel list */}
      {isLoading ? (
        <LoadingState label="Loading channels…" />
      ) : isError ? (
        <ErrorState message="Could not load notification channels." onRetry={() => void refetch()} />
      ) : channels.length === 0 ? (
        <QuickStartPanel
          title="Where should alerts go?"
          description="Pick a channel type. You can assign it to monitors afterwards."
          options={CHANNEL_QUICK_START}
          onPick={openCreate}
        />
      ) : (
        <div className="rounded-2xl overflow-x-auto" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
                {['Name', 'Type', 'Recipient / URL', 'Recovery', 'Status', ''].map((h) => (
                  <th key={h}
                    className={`px-4 py-3 font-mono text-xs uppercase tracking-wider ${h === '' ? 'text-right' : 'text-left'}`}
                    style={{ color: 'var(--m3-secondary)', background: 'var(--m3-surface-container)' }}
                  >{h === '' ? <span className="sr-only">Actions</span> : h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {channels.map((ch, i) => {
                const cfg = ch.config as unknown as Record<string, unknown>
                const recipient = ch.type === 'email'
                  ? String(cfg['to'] ?? '')
                  : ch.type === 'discord' || ch.type === 'teams' || ch.type === 'slack'
                    ? String(cfg['webhookUrl'] ?? '')
                    : String(cfg['url'] ?? '')
                return (
                  <tr key={ch.id}
                    className="transition-colors"
                    style={{ borderTop: i > 0 ? '1px solid var(--m3-outline-variant)' : 'none' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--m3-surface-container)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                  >
                    <td className="px-4 py-3 font-medium" style={{ color: 'var(--m3-on-surface)' }}>{ch.name}</td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5 w-fit px-2 py-0.5 rounded-full text-xs font-medium"
                        style={{ background: 'var(--admin-icon-container)', color: 'var(--admin-icon-color)' }}
                      >
                        {ch.type === 'discord' ? <DiscordIcon size={12} />
                          : ch.type === 'teams' ? <TeamsIcon size={12} />
                          : ch.type === 'slack' ? <SlackIcon size={12} />
                          : <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '12px' }}>{ch.type === 'email' ? 'mail' : 'webhook'}</span>
                        }
                        {ch.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs max-w-xs truncate" style={{ color: 'var(--m3-secondary)' }}>{recipient}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--m3-secondary)' }}>
                      {ch.notifyOnRecovery ? (
                        <span className="flex items-center gap-1" style={{ color: 'var(--m3-up)' }}>
                          <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '14px' }}>check_circle</span> Yes
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1 text-xs font-medium w-fit"
                        style={{ color: ch.enabled ? 'var(--m3-up)' : 'var(--m3-secondary)' }}
                      >
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: ch.enabled ? 'var(--m3-up-bar)' : 'var(--m3-outline-variant)' }} />
                        {ch.enabled ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <ActionBtn icon="edit" title="Edit" label={`Edit ${ch.name}`} onClick={() => setEditingChannel(ch)} />
                        <ActionBtn icon="delete" title="Delete" label={`Delete ${ch.name}`} onClick={() => setConfirmDelete(ch)} danger />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modals */}
      {(showCreate || editingChannel) && (
        <ChannelFormModal
          channel={editingChannel}
          initialType={createType}
          onClose={() => { setShowCreate(false); setEditingChannel(null) }}
          onSaved={handleSaved}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete channel"
          message={`Delete "${confirmDelete.name}"? This will also remove it from all monitors.`}
          confirmLabel="Delete"
          pending={deleteMutation.isPending}
          pendingLabel="Deleting…"
          onConfirm={() => deleteMutation.mutate(confirmDelete.id)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {showSmtp && <SmtpModal onClose={() => setShowSmtp(false)} />}
    </PageContainer>
  )
}

interface DeliveryListResponse {
  deliveries: NotificationDelivery[]
  total: number
  page: number
  pages: number
}

export function DeliveryHistory({ channels }: { channels: NotificationChannel[] }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [channelId, setChannelId] = useState('')
  const [eventType, setEventType] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)
  const params = new URLSearchParams({ page: String(page), limit: '20' })
  if (status) params.set('status', status)
  if (channelId) params.set('channelId', channelId)
  if (eventType) params.set('eventType', eventType)

  const { data, isLoading, isError, refetch } = useQuery<DeliveryListResponse>({
    queryKey: ['notification-deliveries', page, status, channelId, eventType],
    queryFn: () => api.get(`/admin/notifications/deliveries?${params}`),
    refetchInterval: 30_000,
  })
  const detail = useQuery<NotificationDelivery & { attempts: NotificationDeliveryAttempt[] }>({
    queryKey: ['notification-delivery', expanded],
    queryFn: () => api.get(`/admin/notifications/deliveries/${expanded}`),
    enabled: expanded !== null,
  })
  const retry = useMutation({
    mutationFn: (id: number) => api.post(`/admin/notifications/deliveries/${id}/retry`, {}),
    onSuccess: () => {
      toast.success('Retry queued.')
      qc.invalidateQueries({ queryKey: ['notification-deliveries'] })
      qc.invalidateQueries({ queryKey: ['notification-delivery'] })
    },
    onError: (err) => toast.error(err instanceof Error && err.message ? err.message : 'Retry failed'),
  })

  function changeFilter(setter: (value: string) => void, value: string) {
    setter(value)
    setPage(1)
    setExpanded(null)
  }

  function clearFilters() {
    setStatus('')
    setChannelId('')
    setEventType('')
    setPage(1)
    setExpanded(null)
  }

  const filtered = !!(status || channelId || eventType)

  return <section className="space-y-4 pt-2">
    <div className="overflow-x-auto pb-1">
      <div className="grid grid-cols-3 gap-2 min-w-[560px]">
        <select aria-label="Status" className="input-sig text-sm min-w-32" value={status} onChange={(e) => changeFilter(setStatus, e.target.value)}>
          <option value="">All statuses</option><option value="pending">Pending</option><option value="delivered">Delivered</option><option value="failed">Failed</option><option value="suppressed">Suppressed</option>
        </select>
        <select aria-label="Channel" className="input-sig text-sm min-w-40" value={channelId} onChange={(e) => changeFilter(setChannelId, e.target.value)}>
          <option value="">All channels</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
        </select>
        <select aria-label="Event" className="input-sig text-sm min-w-32" value={eventType} onChange={(e) => changeFilter(setEventType, e.target.value)}>
          <option value="">All events</option><option value="alert">Alert</option><option value="recovery">Recovery</option><option value="certificate">Certificate</option><option value="test">Test</option>
        </select>
      </div>
    </div>

    <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
      {isLoading ? <LoadingState label="Loading deliveries…" />
        : isError ? <ErrorState message="Could not load deliveries." onRetry={() => void refetch()} className="rounded-none" />
          : <div className="overflow-x-auto"><table className="w-full text-sm min-w-[850px]">
            <thead><tr style={{ background: 'var(--m3-surface-container)', borderBottom: '1px solid var(--m3-outline-variant)' }}>{['Time', 'Monitor', 'Channel', 'Event', 'Attempts', 'Status', ''].map((label) => <th key={label} className="px-4 py-3 text-left font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>{label === '' ? <span className="sr-only">Details</span> : label}</th>)}</tr></thead>
            <tbody>
              {data?.deliveries.map((delivery) => <DeliveryRow key={delivery.id} delivery={delivery} expanded={expanded === delivery.id} {...(expanded === delivery.id && detail.data ? { detail: detail.data } : {})} onToggle={() => setExpanded(expanded === delivery.id ? null : delivery.id)} onRetry={() => retry.mutate(delivery.id)} retrying={retry.isPending && retry.variables === delivery.id} />)}
              {!data?.deliveries.length && (filtered
                ? <EmptyTableRow colSpan={7} icon="outbox" title="No deliveries match these filters." description={<><EmptyStateLink onClick={clearFilters}>Clear the filters</EmptyStateLink> to see every delivery.</>} />
                : <EmptyTableRow colSpan={7} icon="outbox" title="No deliveries yet" description="Alerts, recoveries and test messages sent to your channels will be listed here." />)}
            </tbody>
          </table></div>}
    </div>
    {data && <Pagination page={page} pageCount={data.pages} onPageChange={(next) => { setPage(next); setExpanded(null) }} summary={`Page ${page} of ${data.pages} · ${data.total} deliveries`} />}
  </section>
}

const SUPPRESSION_LABELS: Record<string, string> = {
  'quiet-hours': 'Quiet hours',
  'throttled': 'Rate cap',
  'grouped': 'Merged into digest',
}

const SUPPRESSION_DETAILS: Record<string, string> = {
  'quiet-hours': 'The channel was inside its quiet window and is set to drop notifications rather than hold them.',
  'throttled': 'This monitor already hit the channel’s alert cap for the current window. Recoveries are never capped.',
  'grouped': 'Several monitors changed state at once, so this event was sent as part of a single digest notification instead.',
}

const STATUS_NAMES: Record<string, string> = {
  up: 'Operational',
  down: 'Down',
  degraded: 'Degraded',
  pending: 'Pending',
  affected: 'Affected',
  'cert-expiring': 'Certificate expiring',
  'cert-renewed': 'Certificate renewed',
}

const EVENT_LABELS: Record<NotificationDelivery['eventType'], string> = {
  alert: 'Alert',
  recovery: 'Recovery',
  certificate: 'Certificate',
  test: 'Test',
}

function DeliveryRow({ delivery, expanded, detail, onToggle, onRetry, retrying }: { delivery: NotificationDelivery; expanded: boolean; detail?: NotificationDelivery & { attempts: NotificationDeliveryAttempt[] }; onToggle: () => void; onRetry: () => void; retrying: boolean }) {
  const statusName = (status: string) => STATUS_NAMES[status] ?? status
  const detailsId = `delivery-details-${delivery.id}`
  const statusColor = delivery.status === 'delivered' ? 'var(--m3-up-bar)' : delivery.status === 'failed' ? 'var(--m3-error)' : delivery.status === 'suppressed' ? 'var(--m3-outline)' : 'var(--m3-degraded-bar)'
  const statusLabel = delivery.status === 'delivered' ? 'Delivered' : delivery.status === 'failed' ? 'Failed' : delivery.status === 'suppressed' ? 'Suppressed' : 'Pending'
  const eventLabel = EVENT_LABELS[delivery.eventType] ?? delivery.eventType
  const suppression = SUPPRESSION_LABELS[delivery.suppressionReason ?? '']
  const heldUntil = delivery.status === 'pending' && delivery.attemptCount === 0 && delivery.nextAttemptAt && delivery.nextAttemptAt > Date.now()
    ? new Date(delivery.nextAttemptAt).toLocaleString()
    : null
  return <>
    <tr className="cursor-pointer" onClick={onToggle} style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
      <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--m3-secondary)' }}>{new Date(delivery.createdAt).toLocaleString()}</td>
      <td className="px-4 py-3"><p className="font-medium">{delivery.monitorName}</p><p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>{statusName(delivery.previousStatus)} → {statusName(delivery.targetStatus)}</p></td>
      <td className="px-4 py-3"><p>{delivery.channelName}</p><p className="text-xs capitalize" style={{ color: 'var(--m3-secondary)' }}>{delivery.channelType}</p></td>
      <td className="px-4 py-3">{eventLabel}</td>
      <td className="px-4 py-3">{delivery.attemptCount}</td>
      <td className="px-4 py-3">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold"><span className="w-2 h-2 rounded-full" aria-hidden="true" style={{ background: statusColor }} />{statusLabel}</span>
        {suppression && <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>{suppression}</p>}
        {heldUntil && <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>Held until {heldUntil}</p>}
      </td>
      <td className="px-4 py-3 text-right">
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); onToggle() }}
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          aria-label={`${expanded ? 'Hide' : 'Show'} details for ${delivery.monitorName} via ${delivery.channelName}`}
          className="btn-icon"
        >
          <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>{expanded ? 'expand_less' : 'expand_more'}</span>
        </button>
      </td>
    </tr>
    {expanded && <tr id={detailsId}><td colSpan={7} className="px-4 py-4" style={{ background: 'var(--m3-surface-container)' }}>
      {delivery.lastError && <Alert tone="error" className="mb-3">{delivery.lastError}</Alert>}
      {suppression && <div className="rounded-xl px-3 py-2 mb-3 text-sm" style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-on-surface-variant)' }}>{SUPPRESSION_DETAILS[delivery.suppressionReason ?? '']}</div>}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2 flex-1"><p className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Attempts</p>{!detail ? <p className="text-sm">Loading…</p> : detail.attempts.length === 0 ? <p className="text-sm" style={{ color: 'var(--m3-secondary)' }}>Never attempted.</p> : detail.attempts.map((attempt) => <div key={attempt.id} className="flex flex-wrap gap-x-4 gap-y-1 text-xs"><span className="font-semibold">#{attempt.attemptNumber}</span><span style={{ color: attempt.status === 'delivered' ? 'var(--m3-up)' : 'var(--m3-down)' }}>{attempt.status === 'delivered' ? 'Delivered' : 'Failed'}</span><span style={{ color: 'var(--m3-secondary)' }}>{new Date(attempt.completedAt).toLocaleString()}</span>{attempt.error && <span style={{ color: 'var(--m3-secondary)' }}>{attempt.error}</span>}</div>)}</div>
        {delivery.status === 'failed' && <button type="button" disabled={retrying} onClick={(event) => { event.stopPropagation(); onRetry() }} className="btn btn-primary whitespace-nowrap">{retrying ? 'Retrying…' : 'Retry now'}</button>}
      </div>
    </td></tr>}
  </>
}

function ActionBtn({ icon, title, label, onClick, danger }: { icon: string; title: string; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label}
      className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors focus-ring"
      style={{ color: danger ? 'var(--m3-secondary)' : 'var(--m3-secondary)' }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = danger ? 'var(--m3-error-container)' : 'var(--m3-surface-container-high)'
        ;(e.currentTarget as HTMLButtonElement).style.color = danger ? 'var(--m3-on-error-container)' : 'var(--m3-on-surface)'
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = ''
        ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--m3-secondary)'
      }}
    >
      <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>{icon}</span>
    </button>
  )
}

// ── SMTP Settings Modal ───────────────────────────────────────────────────────

interface VaultSummary  { id: number; name: string }
interface SecretSummary { id: number; name: string; type: 'userpass' | 'value' | 'json' }

function SmtpModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const titleId = useId()
  const { data: smtp } = useQuery<SmtpSettings>({
    queryKey: ['smtp-settings'],
    queryFn: () => api.get('/admin/notifications/smtp'),
  })

  const [host, setHost]               = useState('')
  const [port, setPort]               = useState(587)
  const [secure, setSecure]           = useState(false)
  const [fromAddress, setFromAddress] = useState('')
  const [fromName, setFromName]       = useState('BSP Alerts')

  // Credential source
  const [credSource, setCredSource]   = useState<'direct' | 'vault'>('direct')
  const [user, setUser]               = useState('')
  const [password, setPassword]       = useState('')
  const [vault, setVault]             = useState<VaultRef | null>(null)

  // Vault data
  const [vaults, setVaults]                 = useState<VaultSummary[]>([])
  const [secretsByVault, setSecretsByVault] = useState<Record<number, SecretSummary[]>>({})

  const [loaded, setLoaded]     = useState(false)
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState('')
  const [testTo, setTestTo]     = useState('')
  const [testing, setTesting]   = useState(false)
  const [testMsg, setTestMsg]   = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    api.get<VaultSummary[]>('/admin/vaults').then(setVaults).catch(() => {})
  }, [])

  async function loadSecrets(vaultId: number) {
    if (secretsByVault[vaultId]) return
    try {
      const secrets = await api.get<SecretSummary[]>(`/admin/vaults/${vaultId}/secrets`)
      setSecretsByVault((prev) => ({ ...prev, [vaultId]: secrets }))
    } catch { /* ignore */ }
  }

  // Populate when data loads
  useEffect(() => {
    if (!smtp || loaded) return
    setHost(smtp.host)
    setPort(smtp.port)
    setSecure(!!smtp.secure)
    setFromAddress(smtp.fromAddress)
    setFromName(smtp.fromName)
    if (smtp.vault) {
      setCredSource('vault')
      setVault(smtp.vault)
      loadSecrets(smtp.vault.vaultId)
    } else {
      setCredSource('direct')
      setUser(smtp.user)
      setPassword(smtp.password)
    }
    setLoaded(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smtp])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      await api.put('/admin/notifications/smtp', {
        host, port, secure: secure ? 1 : 0, fromAddress, fromName,
        user: credSource === 'direct' ? user : '',
        password: credSource === 'direct' ? password : '',
        vault: credSource === 'vault' ? vault : null,
      })
      qc.invalidateQueries({ queryKey: ['smtp-settings'] })
      toast.success('SMTP settings saved.')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    if (!testTo) return
    setTesting(true)
    setTestMsg(null)
    try {
      await api.post('/admin/notifications/smtp/test', { to: testTo })
      setTestMsg({ ok: true, text: `Test email sent to ${testTo}` })
    } catch (err) {
      setTestMsg({ ok: false, text: err instanceof Error ? err.message : 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  const selectedSecret = vault?.vaultId && vault?.secretId
    ? (secretsByVault[vault.vaultId] ?? []).find((s) => s.id === vault.secretId)
    : undefined

  return (
    <ModalShell align="top" onClose={saving ? undefined : onClose} labelledBy={titleId}>
      <div className="rounded-2xl w-full max-w-lg my-8"
        style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
        <ModalHeader icon="forward_to_inbox" titleId={titleId} title="SMTP Settings" onClose={onClose} />

        <form onSubmit={handleSave} className="p-4 sm:p-6 space-y-4">
          {error && <Alert tone="error">{error}</Alert>}
          <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>Used by all email notification channels.</p>

          {/* Host + Port */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <SmtpField label="Host">
                <input value={host} onChange={(e) => setHost(e.target.value)} className="input-sig" placeholder="smtp.example.com" />
              </SmtpField>
            </div>
            <SmtpField label="Port">
              <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} className="input-sig" />
            </SmtpField>
          </div>

          {/* TLS toggle */}
          <Switch label="Use TLS/SSL (port 465)" checked={secure} onChange={setSecure} />

          <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

          {/* Credentials source toggle */}
          <div role="group" aria-labelledby={`${titleId}-credentials`}>
            <p id={`${titleId}-credentials`} className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Credentials</p>
            <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--m3-outline-variant)', width: 'fit-content' }}>
              {(['direct', 'vault'] as const).map((src) => (
                <button key={src} type="button"
                  onClick={() => {
                    setCredSource(src)
                    if (src === 'vault' && vaults[0]) {
                      loadSecrets(vaults[0].id)
                      if (!vault) setVault({ vaultId: vaults[0].id, secretId: 0 })
                    }
                  }}
                  aria-pressed={credSource === src}
                  className={`px-4 py-1.5 text-xs font-medium transition-all focus-ring ${credSource === src ? 'selection-active' : ''}`}
                  style={{ background: 'transparent', color: 'var(--m3-secondary)' }}
                >
                  {src === 'direct' ? 'Direct input' : 'From Vault'}
                </button>
              ))}
            </div>
          </div>

          {/* Direct credentials */}
          {credSource === 'direct' && (
            <>
              <Alert tone="warning">
                For security, store credentials in Vault rather than entering them directly here.
              </Alert>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <SmtpField label="Username">
                  <input value={user} onChange={(e) => setUser(e.target.value)} className="input-sig" placeholder="user@example.com" autoComplete="off" />
                </SmtpField>
                <SmtpField label="Password">
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="input-sig" autoComplete="new-password" placeholder="••••••••" />
                </SmtpField>
              </div>
            </>
          )}

          {/* Vault credentials */}
          {credSource === 'vault' && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <SmtpField label="Vault">
                  <select className="input-sig" value={vault?.vaultId || ''}
                    onChange={(e) => {
                      const id = Number(e.target.value)
                      loadSecrets(id)
                      setVault({ vaultId: id, secretId: 0 })
                    }}
                  >
                    <option value="">— select vault —</option>
                    {vaults.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </SmtpField>
                <SmtpField label="Secret">
                  <select className="input-sig" value={vault?.secretId || ''}
                    disabled={!vault?.vaultId}
                    onChange={(e) => setVault((v) => ({ vaultId: v!.vaultId, secretId: Number(e.target.value) }))}
                  >
                    <option value="">— select secret —</option>
                    {(vault?.vaultId ? (secretsByVault[vault.vaultId] ?? []) : []).map((s) => (
                      <option key={s.id} value={s.id}>{s.name} ({s.type})</option>
                    ))}
                  </select>
                </SmtpField>
              </div>

              {selectedSecret?.type === 'userpass' && (
                <p className="text-xs rounded-lg px-3 py-2" style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)' }}>
                  Auto-mapped: <strong>username</strong> → SMTP user, <strong>password</strong> → SMTP password.
                </p>
              )}

              {selectedSecret?.type === 'value' && (
                <Alert tone="warning">
                  A <strong>value</strong> secret has no username, so SMTP sending will fail. Use a <strong>userpass</strong> or <strong>json</strong> secret.
                </Alert>
              )}

              {selectedSecret?.type === 'json' && vault?.secretId && (
                <div className="space-y-2">
                  <p className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>JSON Field Mapping</p>
                  {(['username', 'password'] as const).map((field) => (
                    <div key={field} className="grid items-center gap-3" style={{ gridTemplateColumns: '90px 1fr' }}>
                      <span className="text-xs font-medium" style={{ color: 'var(--m3-on-surface-variant)' }}>{field}</span>
                      <input className="input-sig text-xs" placeholder={`JSON key (e.g. "${field}")`} aria-label={`JSON key for ${field}`}
                        value={vault?.fieldMapping?.[field] ?? ''}
                        onChange={(e) => setVault((v) => ({
                          ...v!,
                          fieldMapping: { ...(v?.fieldMapping ?? {}), [field]: e.target.value },
                        }))}
                      />
                    </div>
                  ))}
                </div>
              )}

              {vaults.length === 0 && (
                <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>No vaults found. Create one in the Vault section first.</p>
              )}
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

          {/* From */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <SmtpField label="From Address">
              <input value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} className="input-sig" placeholder="alerts@example.com" />
            </SmtpField>
            <SmtpField label="From Name">
              <input value={fromName} onChange={(e) => setFromName(e.target.value)} className="input-sig" />
            </SmtpField>
          </div>

          <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

          {/* Test email */}
          <div className="space-y-2">
            <label htmlFor={`${titleId}-test`} className="block font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>Send Test Email</label>
            <div className="flex gap-2">
              <input
                id={`${titleId}-test`}
                type="email"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="recipient@example.com"
                className="input-sig flex-1"
              />
              <button
                type="button"
                onClick={handleTest}
                disabled={testing || !testTo}
                className="btn btn-secondary flex-shrink-0"
              >
                {testing
                  ? <><span className="material-symbols-outlined animate-spin" aria-hidden="true">progress_activity</span> Sending…</>
                  : <><span className="material-symbols-outlined" aria-hidden="true">send</span> Send</>
                }
              </button>
            </div>
            {testMsg && <Alert tone={testMsg.ok ? 'success' : 'error'}>{testMsg.text}</Alert>}
          </div>

          <div className="flex flex-wrap justify-end gap-3 pt-1">
            <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
            <button type="submit" disabled={saving} className="btn btn-primary">
              {saving ? 'Saving…' : 'Save Settings'}
            </button>
          </div>
        </form>
      </div>
    </ModalShell>
  )
}

function SmtpField({ label, children }: { label: string; children: ReactElement<Partial<FieldControlProps>> }) {
  return <Field label={label}>{children}</Field>
}
