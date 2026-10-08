import { Link, useSearchParams } from 'react-router-dom'
import { SubscriberDeliveryHistory } from '../components/subscribers/SubscriberDeliveryHistory'
import { PageContainer, PageHeader } from '../components/ui'

export default function SubscriberHistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const id = Number(searchParams.get('subscriberId'))
  const subscriberId = Number.isInteger(id) && id > 0 ? id : undefined

  return <PageContainer>
    <div>
      <Link to="/admin/subscribers" className="inline-flex items-center gap-1 text-sm mb-3 rounded focus-ring hover:underline" style={{ color: 'var(--m3-secondary)' }}>
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '18px' }}>arrow_back</span>
        Subscribers
      </Link>
      <PageHeader title="Subscriber delivery history" subtitle="Inspect notifications sent to subscribers, their errors, and manually retry failed ones." />
    </div>
    <SubscriberDeliveryHistory subscriberId={subscriberId} onClearSubscriber={() => setSearchParams({}, { replace: true })} />
  </PageContainer>
}
