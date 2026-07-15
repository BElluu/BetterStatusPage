import { useState } from 'react'
import type { Incident, PublicMonitor } from '@bsp/shared'
import { useLocale } from '../i18n/LocaleContext'

function formatDate(ms: number, locale: string) {
  return new Date(ms).toLocaleDateString(locale, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

function formatTime(ms: number, locale: string) {
  return new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC'
}

function formatDuration(startMs: number, endMs: number) {
  const diff = Math.abs(endMs - startMs)
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export function IncidentCard({ incident, monitors = [] }: { incident: Incident; monitors?: PublicMonitor[] }) {
  const { t, locale } = useLocale()
  const [expanded, setExpanded] = useState(false)

  const statusCfg: Record<string, { color: string; dotColor: string; badgeBg: string }> = {
    investigating: { color: 'var(--bsp-down)', dotColor: 'var(--bsp-down)', badgeBg: 'color-mix(in srgb, var(--bsp-down) 10%, transparent)' },
    identified:    { color: 'var(--bsp-degraded)', dotColor: 'var(--bsp-degraded)', badgeBg: 'color-mix(in srgb, var(--bsp-degraded) 10%, transparent)' },
    monitoring:    { color: 'var(--bsp-primary)', dotColor: 'var(--bsp-primary)', badgeBg: 'color-mix(in srgb, var(--bsp-primary) 10%, transparent)' },
    resolved:      { color: 'var(--bsp-up)', dotColor: 'var(--bsp-up)', badgeBg: 'color-mix(in srgb, var(--bsp-up) 10%, transparent)' },
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
    .filter(Boolean) as PublicMonitor[]

  /* ── Resolved: collapsible row ──────────────────────────────────── */
  if (!isActive) {
    const duration = incident.resolvedAt ? formatDuration(incident.startedAt, incident.resolvedAt) : null
    return (
      <div
        className="bsp-incident-card"
        style={{
          borderBottom: '1px solid var(--m3-outline-variant)',
          borderRadius: '16px',
        }}
      >
        {/* ── Header row ── */}
        <button
          className="w-full text-left transition-colors"
          style={{
            display: 'grid',
            gridTemplateColumns: '200px 1fr auto auto',
            gap: '40px',
            alignItems: 'center',
            padding: '28px 40px',
            borderRadius: '16px',
            background: 'transparent',
            cursor: updates.length > 0 ? 'pointer' : 'default',
          }}
          onClick={() => updates.length > 0 && setExpanded((v) => !v)}
          onMouseEnter={(e) => { if (updates.length > 0) (e.currentTarget as HTMLButtonElement).style.background = 'var(--m3-surface-container-low)' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
        >
          {/* Date */}
          <div className="font-mono text-xs uppercase tracking-widest" style={{ color: 'var(--m3-secondary)' }}>
            {formatDate(incident.startedAt, locale)}
            <br />
            <span className="text-xs normal-case">{formatTime(incident.startedAt, locale)}</span>
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

          {/* Chevron */}
          {updates.length > 0 && (
            <span
              className="material-symbols-outlined transition-transform"
              style={{
                fontSize: '20px',
                color: 'var(--m3-secondary)',
                transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
              }}
            >
              expand_more
            </span>
          )}
        </button>

        {/* ── Expanded timeline ── */}
        {expanded && updates.length > 0 && (
          <div style={{ padding: '0 40px 32px 240px' }}>
            <div className="space-y-6" style={{ borderLeft: '2px solid var(--m3-outline-variant)', paddingLeft: '32px' }}>
                {updates.map((update, i) => {
                  const updateCfg = statusCfg[update.status] ?? statusCfg['investigating']!
                  const isLatest  = i === 0
                  return (
                    <div key={update.id} className="relative">
                      <span
                        className="absolute rounded-full"
                        style={{
                          left: '-37px',
                          top: '4px',
                          width: '8px',
                          height: '8px',
                          background: isLatest ? updateCfg.dotColor : 'var(--m3-outline-variant)',
                          outline: '3px solid var(--m3-surface)',
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
          </div>
        )}
      </div>
    )
  }

  /* ── Active: full card ───────────────────────────────────────────── */
  return (
    <div
      className="bsp-incident-card"
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
