export type DeliveryHistoryTab = 'notifications' | 'subscribers'

/** Address of one delivery history tab; the subscriber tab can be narrowed to one subscriber. */
export function deliveryHistoryUrl(tab: DeliveryHistoryTab, subscriberId?: number): string {
  const params = new URLSearchParams({ tab })
  if (subscriberId !== undefined) params.set('subscriberId', String(subscriberId))
  return `/admin/delivery-history?${params.toString()}`
}
