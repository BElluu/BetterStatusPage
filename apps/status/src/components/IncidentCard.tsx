import type { Incident, Monitor } from '@bsp/shared'
import { useLocale } from '../i18n/LocaleContext'

function formatDate(ms: number, locale: string) {
  return new Date(ms).toLocaleDateString(locale, { month: 'long', day: 'numeric', year: 'numeric' })
}

function formatTime(ms: number, locale: string) {
  return new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false }) + ' UTC'
}

function formatDuration(startMs: number, endMs: number) {
  const diff = Math.abs(endMs - startMs)
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export function IncidentCard({ incident, monitors = [] }: { incident: Incident; monitors?: Monitor[] }) {
  const { t, locale } = useLocale()

  const statusCfg: Record<string, { color: string; dotColor: string; badgeBg: string }> = {
    investigating: { color: '#ba1a1a', dotColor: '#ba1a1a', badgeBg: 'rgba(186,26,26,0.08)' },
    identified:    { color: '#eab308', dotColor: '#eab308', badgeBg: 'rgba(234,179,8,0.10)' },
    monitoring:    { color: '#3980f4', dotColor: '#3980f4', badgeBg: 'rgba(57,128,244,0.10)' },
    resolved:      { color: '#22c55e', dotColor: '#22c55e', badgeBg: 'rgba(34,197,94,0.10)' },
  }

  const statusLabels: Record<string, string> = {
    investigating: t('incident.investigating'),
    identified:    t('incident.identified'),
    monitoring:    t('incident.monitoring'),
    resolved:      t('incident.resolved'),
  }

  const cfg      = statusCfg[incident.status] ?? statusCfg['investigating']!
  const isActive = incident.status !== 'resolved'
  const updates  = incident.updates ?? []

  const affectedMonitors = (incident.monitorIds ?? [])
    .map((id) => monitors.find((m) => m.id === id))
    .filter(Boolean) as Monitor[]

  /* ── Resolved: slim row ──────────────────────────────────────────── */
  if (!isActive) {
    const duration = incident.resolvedAt ? formatDuration(incident.startedAt, incident.resolvedAt) : null
    return (
      <div
        className="group transition-colors"
        style={{
          display: 'grid',
          gridTemplateColumns: '200px 1fr auto',
          gap: '40px',
          alignItems: 'center',
          padding: '28px 40px',
          borderBottom: '1px solid var(--m3-outline-variant)',
          borderRadius: '16px',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--m3-surface-container-low)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = '' }}
      >
        {/* Date */}
        <div className="font-mono text-xs uppercase tracking-widest" style={{ color: 'var(--m3-secondary)' }}>
          {formatDate(incident.startedAt, locale)}
        </div>

        {/* Title + subtitle */}
        <div>
          <h4 className="font-headline font-bold text-xl" style={{ color: 'var(--m3-on-surface)' }}>
            {incident.title}
          </h4>
          {duration && (
            <p className="text-sm mt-1" style={{ color: 'var(--m3-secondary)' }}>
              {t('uptime.resolvedIn', { duration })}.{affectedMonitors.length > 0 && ` ${t('uptime.affected')}: ${affectedMonitors.map((m) => m.name).join(', ')}.`}
            </p>
          )}
        </div>

        {/* Badge */}
        <span
          className="font-bold text-xs uppercase tracking-wide whitespace-nowrap"
          style={{
            padding: '6px 16px',
            borderRadius: '999px',
            background: 'var(--m3-surface-container-high)',
            color: 'var(--m3-secondary)',
          }}
        >
          {t('incident.resolved')}
        </span>
      </div>
    )
  }

  /* ── Active: full card ───────────────────────────────────────────── */
  return (
    <div
      style={{
        background: 'var(--m3-surface-container-low)',
        borderRadius: '2rem',
        padding: '40px',
        borderLeft: `4px solid ${cfg.color}`,
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: '40px' }}>

        {/* ── Date column ── */}
        <div className="font-mono text-sm uppercase tracking-widest pt-1" style={{ color: 'var(--m3-secondary)' }}>
          {formatDate(incident.startedAt, locale)}
          <br />
          <span className="text-xs">{formatTime(incident.startedAt, locale)}</span>
        </div>

        {/* ── Content column ── */}
        <div>
          {/* Status badge */}
          <span
            className="inline-block font-bold text-xs uppercase tracking-tight rounded-full mb-4"
            style={{
              padding: '4px 12px',
              background: cfg.badgeBg,
              color: cfg.color,
            }}
          >
            {statusLabels[incident.status] ?? t('incident.investigating')}
            {isActive && (
              <span
                className="animate-pulse inline-block rounded-full ml-1.5"
                style={{ width: 5, height: 5, background: cfg.color, verticalAlign: 'middle' }}
              />
            )}
          </span>

          {/* Title */}
          <h3
            className="font-headline font-bold mb-4 leading-tight"
            style={{ fontSize: '28px', color: 'var(--m3-on-surface)' }}
          >
            {incident.title}
          </h3>

          {/* Affected monitors */}
          {affectedMonitors.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-6">
              {affectedMonitors.map((m) => (
                <span
                  key={m.id}
                  className="text-xs font-medium"
                  style={{
                    padding: '3px 10px',
                    borderRadius: '999px',
                    background: 'var(--m3-surface-container)',
                    color: 'var(--m3-secondary)',
                  }}
                >
                  {m.name}
                </span>
              ))}
            </div>
          )}

          {/* Timeline updates */}
          {updates.length > 0 && (
            <div className="space-y-6" style={{ borderLeft: '2px solid var(--m3-outline-variant)', paddingLeft: '32px' }}>
              {updates.slice(0, 4).map((update, i) => {
                const updateCfg = statusCfg[update.status] ?? statusCfg['investigating']!
                const isLatest  = i === 0
                return (
                  <div key={update.id} className="relative">
                    {/* Timeline dot */}
                    <span
                      className="absolute rounded-full"
                      style={{
                        left: '-37px',
                        top: '4px',
                        width: '8px',
                        height: '8px',
                        background: isLatest ? updateCfg.dotColor : 'var(--m3-outline-variant)',
                        outline: '3px solid var(--m3-surface-container-low)',
                      }}
                    />
                    <span
                      className="block text-xs font-bold uppercase tracking-widest mb-1"
                      style={{ color: isLatest ? updateCfg.color : 'var(--m3-secondary)' }}
                    >
                      {formatTime(update.postedAt, locale)} — {statusLabels[update.status] ?? t('incident.investigating')}
                    </span>
                    <p
                      className="text-sm font-sans leading-relaxed"
                      style={{ color: 'var(--m3-on-surface)', opacity: isLatest ? 1 : 0.7 }}
                    >
                      {update.body}
                    </p>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
