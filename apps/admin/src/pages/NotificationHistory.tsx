import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { NotificationChannel } from '@bsp/shared'
import { api } from '../api/client'
import { DeliveryHistory } from './Notifications'
import { useAdminLocale } from '../i18n/LocaleContext'

export default function NotificationHistoryPage() {
  const { t } = useAdminLocale()
  const { data: channels = [] } = useQuery<NotificationChannel[]>({
    queryKey: ['notification-channels'],
    queryFn: () => api.get('/admin/notifications/channels'),
  })

  return <div className="p-8 space-y-6 fade-up">
    <div>
      <Link to="/admin/notifications" className="inline-flex items-center gap-1 text-sm mb-3" style={{ color: 'var(--m3-secondary)' }}>
        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>arrow_back</span>
        {t('notifications.history.back')}
      </Link>
      <h1 className="font-headline font-bold text-2xl" style={{ color: 'var(--m3-on-surface)' }}>{t('notifications.history.title')}</h1>
      <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>{t('notifications.history.subtitle')}</p>
    </div>
    <DeliveryHistory channels={channels} />
  </div>
}
