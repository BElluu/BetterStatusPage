import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { NotificationChannel } from '@bsp/shared'
import { api } from '../api/client'
import { PageContainer, PageHeader } from '../components/ui'
import { DeliveryHistory } from './Notifications'

export default function NotificationHistoryPage() {
  const { data: channels = [] } = useQuery<NotificationChannel[]>({
    queryKey: ['notification-channels'],
    queryFn: () => api.get('/admin/notifications/channels'),
  })

  return <PageContainer>
    <div>
      <Link to="/admin/notifications" className="inline-flex items-center gap-1 text-sm mb-3 rounded focus-ring hover:underline" style={{ color: 'var(--m3-secondary)' }}>
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>arrow_back</span>
        Notification channels
      </Link>
      <PageHeader title="Notification delivery history" subtitle="Inspect delivery attempts, errors and manually retry failed notifications." />
    </div>
    <DeliveryHistory channels={channels} />
  </PageContainer>
}
