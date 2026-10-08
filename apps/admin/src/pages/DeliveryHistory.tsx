import { useQuery } from '@tanstack/react-query'
import { Navigate, useSearchParams } from 'react-router-dom'
import type { NotificationChannel } from '@bsp/shared'
import { api } from '../api/client'
import { deliveryHistoryUrl, type DeliveryHistoryTab } from '../deliveryHistoryUrl'
import { SubscriberDeliveryHistory } from '../components/subscribers/SubscriberDeliveryHistory'
import { PageContainer, PageHeader } from '../components/ui'
import { DeliveryHistory as NotificationDeliveryHistory } from './Notifications'

const TABS: { key: DeliveryHistoryTab; label: string }[] = [
  { key: 'notifications', label: 'Notifications' },
  { key: 'subscribers', label: 'Subscribers' },
]

/** Keeps the addresses of the former separate history pages working. */
export function DeliveryHistoryRedirect({ tab }: { tab: DeliveryHistoryTab }) {
  const [searchParams] = useSearchParams()
  const id = Number(searchParams.get('subscriberId'))
  return <Navigate to={deliveryHistoryUrl(tab, Number.isInteger(id) && id > 0 ? id : undefined)} replace />
}

function NotificationsTab() {
  const { data: channels = [] } = useQuery<NotificationChannel[]>({
    queryKey: ['notification-channels'],
    queryFn: () => api.get('/admin/notifications/channels'),
  })
  return <NotificationDeliveryHistory channels={channels} />
}

function SubscribersTab() {
  const [searchParams, setSearchParams] = useSearchParams()
  const id = Number(searchParams.get('subscriberId'))
  const subscriberId = Number.isInteger(id) && id > 0 ? id : undefined
  return <SubscriberDeliveryHistory subscriberId={subscriberId} onClearSubscriber={() => setSearchParams({ tab: 'subscribers' }, { replace: true })} />
}

export default function DeliveryHistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab: DeliveryHistoryTab = searchParams.get('tab') === 'subscribers' ? 'subscribers' : 'notifications'

  return (
    <PageContainer>
      <PageHeader
        title="Delivery history"
        subtitle="Inspect delivery attempts and errors, and manually retry failed ones."
      >
        <div role="tablist" aria-label="Delivery history sections" className="flex gap-6" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
          {TABS.map((item) => {
            const active = tab === item.key
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                id={`delivery-history-tab-${item.key}`}
                aria-selected={active}
                aria-controls="delivery-history-panel"
                onClick={() => setSearchParams({ tab: item.key })}
                className="inline-flex items-center gap-2 px-0.5 pb-3 -mb-px text-sm font-semibold focus-ring"
                style={{ borderBottom: `2px solid ${active ? 'var(--m3-on-surface)' : 'transparent'}`, color: active ? 'var(--m3-on-surface)' : 'var(--m3-secondary)' }}
              >
                {item.label}
              </button>
            )
          })}
        </div>
      </PageHeader>

      <div role="tabpanel" id="delivery-history-panel" aria-labelledby={`delivery-history-tab-${tab}`}>
        {tab === 'notifications' ? <NotificationsTab /> : <SubscribersTab />}
      </div>
    </PageContainer>
  )
}
