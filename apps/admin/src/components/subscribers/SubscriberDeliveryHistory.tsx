import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SubscriberDelivery, SubscriberDeliveryList } from '@bsp/shared'
import { SUBSCRIBER_EVENT_TYPES } from '@bsp/shared'
import { api } from '../../api/client'
import { SUBSCRIBER_EVENT_LABELS } from '../../pages/Subscribers'
import { Alert, EmptyStateLink, EmptyTableRow, ErrorState, LoadingState, Pagination, useToast } from '../ui'
import { formatDateTime } from '../../lib/dateFormat'

const STATUS_STYLE: Record<SubscriberDelivery['status'], { color: string; label: string }> = {
  delivered: { color: 'var(--m3-up-bar)', label: 'Delivered' },
  failed: { color: 'var(--m3-error)', label: 'Failed' },
  cancelled: { color: 'var(--m3-outline)', label: 'Cancelled' },
  pending: { color: 'var(--m3-degraded-bar)', label: 'Pending' },
}

const CANCELLED_DETAIL = 'The subscriber was no longer active, or subscriptions were switched off, before this could be sent.'

interface Props {
  /** Limits the list to one subscriber; the page shows a chip that clears it. */
  subscriberId?: number | undefined
  onClearSubscriber: () => void
}

export function SubscriberDeliveryHistory({ subscriberId, onClearSubscriber }: Props) {
  const qc = useQueryClient()
  const toast = useToast()
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [eventType, setEventType] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)

  const params = new URLSearchParams({ page: String(page), limit: '20' })
  if (status) params.set('status', status)
  if (eventType) params.set('eventType', eventType)
  if (subscriberId !== undefined) params.set('subscriberId', String(subscriberId))

  const { data, isLoading, isError, refetch } = useQuery<SubscriberDeliveryList>({
    queryKey: ['subscriber-deliveries', page, status, eventType, subscriberId ?? null],
    queryFn: () => api.get(`/admin/subscribers/deliveries?${params}`),
    refetchInterval: 30_000,
  })
  const retry = useMutation({
    mutationFn: (id: number) => api.post(`/admin/subscribers/deliveries/${id}/retry`, {}),
    onSuccess: () => {
      toast.success('Retry queued.')
      qc.invalidateQueries({ queryKey: ['subscriber-deliveries'] })
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
    setEventType('')
    setPage(1)
    setExpanded(null)
    onClearSubscriber()
  }

  const filtered = !!(status || eventType || subscriberId !== undefined)
  const chipLabel = data?.deliveries[0]?.destination ?? `Subscriber #${subscriberId}`

  return <section className="space-y-4 pt-2">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="grid grid-cols-2 gap-2 w-[28rem] max-w-full">
        <select aria-label="Status" className="input-sig text-sm" value={status} onChange={(e) => changeFilter(setStatus, e.target.value)}>
          <option value="">All statuses</option><option value="pending">Pending</option><option value="delivered">Delivered</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option>
        </select>
        <select aria-label="Event" className="input-sig text-sm" value={eventType} onChange={(e) => changeFilter(setEventType, e.target.value)}>
          <option value="">All events</option>
          {SUBSCRIBER_EVENT_TYPES.map((type) => <option key={type} value={type}>{SUBSCRIBER_EVENT_LABELS[type].label}</option>)}
        </select>
        </div>
        {subscriberId !== undefined && (
          <span className="inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-full text-sm selection-active" style={{ border: '1px solid var(--admin-selection-border)' }}>
            {chipLabel}
            <button type="button" onClick={() => { onClearSubscriber(); setPage(1); setExpanded(null) }} aria-label="Show all subscribers" className="btn-icon" style={{ width: '1.375rem', height: '1.375rem', color: 'inherit' }}>
              <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px' }}>close</span>
            </button>
          </span>
        )}
      </div>
      <span className="text-xs" style={{ color: 'var(--m3-secondary)' }}>Failed sends retry after 1, 5 and 30 minutes. Records are kept for 90 days.</span>
    </div>

    <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
      {isLoading ? <LoadingState label="Loading deliveries…" />
        : isError ? <ErrorState message="Could not load deliveries." onRetry={() => void refetch()} className="rounded-none" />
          : <div className="overflow-x-auto"><table className="w-full text-sm min-w-[850px]">
            <thead><tr style={{ background: 'var(--m3-surface-container)', borderBottom: '1px solid var(--m3-outline-variant)' }}>{['Time', 'Subscriber', 'Event', 'Attempts', 'Status', ''].map((label) => <th key={label} className="px-4 py-3 text-left font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--m3-secondary)' }}>{label === '' ? <span className="sr-only">Details</span> : label}</th>)}</tr></thead>
            <tbody>
              {data?.deliveries.map((delivery) => <DeliveryRow key={delivery.id} delivery={delivery} expanded={expanded === delivery.id} onToggle={() => setExpanded(expanded === delivery.id ? null : delivery.id)} onRetry={() => retry.mutate(delivery.id)} retrying={retry.isPending && retry.variables === delivery.id} />)}
              {!data?.deliveries.length && (filtered
                ? <EmptyTableRow colSpan={6} icon="outbox" title="No deliveries match these filters." description={<><EmptyStateLink onClick={clearFilters}>Clear the filters</EmptyStateLink> to see every delivery.</>} />
                : <EmptyTableRow colSpan={6} icon="outbox" title="No deliveries yet" description="Notifications sent to subscribers will be listed here." />)}
            </tbody>
          </table></div>}
    </div>
    {data && <Pagination page={page} pageCount={data.pages} onPageChange={(next) => { setPage(next); setExpanded(null) }} summary={`Page ${page} of ${data.pages} · ${data.total} deliveries`} />}
  </section>
}

function DeliveryRow({ delivery, expanded, onToggle, onRetry, retrying }: { delivery: SubscriberDelivery; expanded: boolean; onToggle: () => void; onRetry: () => void; retrying: boolean }) {
  const detailsId = `subscriber-delivery-details-${delivery.id}`
  const style = STATUS_STYLE[delivery.status]
  const webhook = delivery.subscriberType === 'webhook'
  const nextAttempt = delivery.status === 'pending' && delivery.nextAttemptAt
    ? formatDateTime(delivery.nextAttemptAt)
    : null
  return <>
    <tr className="cursor-pointer" onClick={onToggle} style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
      <td className="px-4 py-3 whitespace-nowrap align-top" style={{ color: 'var(--m3-secondary)' }}>{formatDateTime(delivery.createdAt)}</td>
      <td className="px-4 py-3 align-top">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px', color: 'var(--m3-secondary)' }}>{webhook ? 'webhook' : 'mail'}</span>
          <span className="font-medium break-all">{delivery.destination}</span>
        </div>
      </td>
      <td className="px-4 py-3 align-top"><p>{SUBSCRIBER_EVENT_LABELS[delivery.eventType]?.label ?? delivery.eventType}</p>{delivery.subject && <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>{delivery.subject}</p>}</td>
      <td className="px-4 py-3 align-top">{delivery.attemptCount} / {delivery.maxAttempts}</td>
      <td className="px-4 py-3 align-top">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold"><span className="w-2 h-2 rounded-full" aria-hidden="true" style={{ background: style.color }} />{style.label}</span>
        {nextAttempt && <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>Next attempt {nextAttempt}</p>}
      </td>
      <td className="px-4 py-3 text-right align-top">
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); onToggle() }}
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          aria-label={`${expanded ? 'Hide' : 'Show'} details for ${delivery.destination}`}
          className="btn-icon"
        >
          <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>{expanded ? 'expand_less' : 'expand_more'}</span>
        </button>
      </td>
    </tr>
    {expanded && <tr id={detailsId}><td colSpan={6} className="px-4 py-4" style={{ background: 'var(--m3-surface-container)' }}>
      {delivery.lastError && <Alert tone="error" className="mb-3">{delivery.lastError}</Alert>}
      {delivery.status === 'cancelled' && <div className="rounded-xl px-3 py-2 mb-3 text-sm" style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-on-surface-variant)' }}>{CANCELLED_DETAIL}</div>}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 flex-1 text-xs">
          <p className="font-mono uppercase tracking-wider mb-2" style={{ color: 'var(--m3-secondary)' }}>Attempts</p>
          <p>{delivery.attemptCount === 0 ? 'Never attempted.' : `${delivery.attemptCount} of ${delivery.maxAttempts} attempts used.`}</p>
          {delivery.deliveredAt && <p style={{ color: 'var(--m3-up)' }}>Delivered {formatDateTime(delivery.deliveredAt)}</p>}
          {delivery.status !== 'delivered' && delivery.attemptCount > 0 && <p style={{ color: 'var(--m3-secondary)' }}>Last attempt {formatDateTime(delivery.updatedAt)}</p>}
          <p className="pt-1" style={{ color: 'var(--m3-secondary)' }}>{webhook ? `Webhook to ${delivery.destination} with X-BSP-Event: ${delivery.eventType}` : `Email to ${delivery.destination}`}</p>
        </div>
        {delivery.status === 'failed' && <button type="button" disabled={retrying} onClick={(event) => { event.stopPropagation(); onRetry() }} className="btn btn-primary whitespace-nowrap">{retrying ? 'Retrying…' : 'Retry now'}</button>}
      </div>
    </td></tr>}
  </>
}
