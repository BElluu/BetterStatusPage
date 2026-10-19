import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { SNAPSHOT_URL, loadSnapshot, snapshotStaleMs } from '../dataSource'
import { useLocale } from '../i18n/LocaleContext'

/**
 * Tells visitors of a saved copy of the page when its data was taken, and warns once it is old. The operator may
 * switch it off, for a copy that should look like the live page.
 */
export function SnapshotBanner() {
  const { t, locale } = useLocale()
  const { data } = useQuery({
    queryKey: ['snapshot-time'],
    queryFn: () => loadSnapshot(SNAPSHOT_URL!),
    select: (snapshot) => ({ at: snapshot.generatedAt, staleMs: snapshotStaleMs(snapshot), shown: snapshot.showBanner !== false }),
    refetchInterval: 60_000,
    enabled: !!SNAPSHOT_URL,
  })
  // The age grows while the file stays the same, so the page has to look at the clock itself.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  if (!data?.shown) return null

  const stale = now - data.at > data.staleMs
  const time = new Date(data.at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <div
      // Read out once, when the copy turns old; a fresh time every minute is not news.
      aria-live={stale ? 'polite' : 'off'}
      className="bsp-snapshot-banner px-4 py-2 text-sm font-semibold text-center"
      style={{
        background: stale ? 'var(--bsp-degraded)' : 'var(--m3-secondary-container, var(--bsp-action-bg))',
        color: stale ? 'var(--bsp-bg)' : 'var(--bsp-action-fg)',
      }}
    >
      {t(stale ? 'snapshot.stale' : 'snapshot.currentAsOf', { time })}
    </div>
  )
}
