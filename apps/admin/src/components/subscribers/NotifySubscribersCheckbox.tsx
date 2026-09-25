import { useQuery } from '@tanstack/react-query'
import type { AdminSubscriptionSettings } from '@bsp/shared'
import { api } from '../../api/client'

/** Lets an operator publish quietly. Renders nothing while subscriptions are switched off. */
export function NotifySubscribersCheckbox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const { data: settings } = useQuery<AdminSubscriptionSettings>({
    queryKey: ['subscription-settings'],
    queryFn: () => api.get('/admin/subscribers/settings'),
    staleTime: 60_000,
  })
  if (!settings?.enabled) return null
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer select-none" style={{ color: 'var(--m3-on-surface-variant)' }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: 'var(--admin-control-accent)' }}
      />
      Notify subscribers
    </label>
  )
}
