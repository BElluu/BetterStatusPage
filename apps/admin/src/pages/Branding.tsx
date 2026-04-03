import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Branding } from '@bsp/shared'

interface BrandingForm {
  siteName: string
  primaryColor: string
  accentColor: string
  backgroundColor: string
  cardBackground: string
  cardBorderColor: string
  textColor: string
  textMutedColor: string
  statusUpColor: string
  statusDownColor: string
  statusDegradedColor: string
  customCss: string
}

const DEFAULTS: BrandingForm = {
  siteName: 'Status Page',
  primaryColor: '#00d4af',
  accentColor: '#f5a623',
  backgroundColor: '#080d18',
  cardBackground: '#0d1526',
  cardBorderColor: 'rgba(255,255,255,0.07)',
  textColor: '#e8edf5',
  textMutedColor: '#5a6a8a',
  statusUpColor: '#00d4af',
  statusDownColor: '#ff4d6a',
  statusDegradedColor: '#f5a623',
  customCss: '',
}

export default function BrandingPage() {
  const qc = useQueryClient()
  const { data: branding } = useQuery<Branding>({
    queryKey: ['branding'],
    queryFn: () => api.get('/admin/branding'),
  })

  const [form, setForm] = useState<BrandingForm>(DEFAULTS)
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (branding) {
      setForm({
        siteName: branding.siteName,
        primaryColor: branding.primaryColor,
        accentColor: branding.accentColor,
        backgroundColor: branding.backgroundColor ?? DEFAULTS.backgroundColor,
        cardBackground: branding.cardBackground ?? DEFAULTS.cardBackground,
        cardBorderColor: branding.cardBorderColor ?? DEFAULTS.cardBorderColor,
        textColor: branding.textColor ?? DEFAULTS.textColor,
        textMutedColor: branding.textMutedColor ?? DEFAULTS.textMutedColor,
        statusUpColor: branding.statusUpColor ?? DEFAULTS.statusUpColor,
        statusDownColor: branding.statusDownColor ?? DEFAULTS.statusDownColor,
        statusDegradedColor: branding.statusDegradedColor ?? DEFAULTS.statusDegradedColor,
        customCss: branding.customCss ?? '',
      })
    }
  }, [branding])

  const saveMutation = useMutation({
    mutationFn: async () => {
      await api.patch('/admin/branding', { ...form, customCss: form.customCss || null })
      if (logoFile) {
        const fd = new FormData()
        fd.append('file', logoFile)
        await api.upload('/admin/branding/logo', fd)
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['branding'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  const set = (key: keyof BrandingForm) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }))

  const currentLogoUrl = logoPreviewUrl ?? branding?.logoUrl ?? null

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Controls panel ── */}
      <div className="w-80 shrink-0 flex flex-col overflow-hidden" style={{ background: 'var(--sig-surface)', borderRight: '1px solid var(--sig-border)' }}>
        <div className="px-5 py-4 shrink-0" style={{ borderBottom: '1px solid var(--sig-border)' }}>
          <h2 className="font-display font-bold text-base" style={{ color: 'var(--sig-text)' }}>Branding</h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--sig-text-muted)' }}>Wygląd publicznej strony statusów</p>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Tożsamość */}
          <Section title="Tożsamość">
            <Field label="Nazwa strony">
              <input value={form.siteName} onChange={(e) => set('siteName')(e.target.value)}
                className="input-sig" placeholder="My Status Page" />
            </Field>
            <Field label="Logo">
              {currentLogoUrl && (
                <img src={currentLogoUrl} alt="Logo" className="h-8 object-contain rounded px-2 py-1 mb-2" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--sig-border)' }} />
              )}
              <input type="file" accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null
                  setLogoFile(file)
                  if (file) setLogoPreviewUrl(URL.createObjectURL(file))
                }}
                className="block text-xs cursor-pointer"
                style={{ color: 'var(--sig-text-muted)' }}
              />
            </Field>
          </Section>

          {/* Tło i karty */}
          <Section title="Tło i karty">
            <ColorField label="Tło strony" value={form.backgroundColor} onChange={set('backgroundColor')} />
            <ColorField label="Tło kart / elementów" value={form.cardBackground} onChange={set('cardBackground')} />
            <ColorField label="Obramowanie kart" value={form.cardBorderColor} onChange={set('cardBorderColor')} />
          </Section>

          {/* Tekst */}
          <Section title="Tekst">
            <ColorField label="Tekst główny" value={form.textColor} onChange={set('textColor')} />
            <ColorField label="Tekst drugorzędny" value={form.textMutedColor} onChange={set('textMutedColor')} />
          </Section>

          {/* Statusy */}
          <Section title="Kolory statusów">
            <ColorField label="Operational (↑)" value={form.statusUpColor} onChange={set('statusUpColor')} />
            <ColorField label="Down (↓)" value={form.statusDownColor} onChange={set('statusDownColor')} />
            <ColorField label="Degraded (~)" value={form.statusDegradedColor} onChange={set('statusDegradedColor')} />
          </Section>

          {/* Akcent */}
          <Section title="Akcent">
            <ColorField label="Kolor główny" value={form.primaryColor} onChange={set('primaryColor')} />
            <ColorField label="Kolor akcentu" value={form.accentColor} onChange={set('accentColor')} />
          </Section>

          {/* Custom CSS */}
          <Section title="Custom CSS">
            <p className="text-[10px] text-slate-500 mb-2 leading-relaxed">
              Dostępne klasy:{' '}
              {[
                '.bsp-page', '.bsp-header', '.bsp-status-banner',
                '.bsp-monitor-card', '.bsp-monitor-name', '.bsp-monitor-type',
                '.bsp-monitor-status', '.bsp-uptime-bar',
                '.bsp-group-card', '.bsp-group-header', '.bsp-group-label',
                '.bsp-text-block', '.bsp-divider', '.bsp-footer',
              ].map((cls) => (
                <code key={cls} className="text-indigo-400 mr-1">{cls}</code>
              ))}
            </p>
            <textarea
              value={form.customCss}
              onChange={(e) => set('customCss')(e.target.value)}
              rows={8}
              className="input-sig font-mono text-xs resize-none"
              placeholder="/* np. .bsp-monitor-card { border-radius: 0; } */"
            />
          </Section>
        </div>

        {/* Save */}
        <div className="px-5 py-4 shrink-0 flex items-center gap-3" style={{ borderTop: '1px solid var(--sig-border)' }}>
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="flex-1 text-sm font-semibold py-2 rounded-lg transition-all"
            style={{
              background: saveMutation.isPending ? 'rgba(0,212,175,0.3)' : 'linear-gradient(135deg, #00d4af 0%, #00a88a 100%)',
              color: saveMutation.isPending ? 'rgba(0,0,0,0.5)' : '#080d18',
              opacity: saveMutation.isPending ? 0.7 : 1,
            }}
          >
            {saveMutation.isPending ? 'Zapisuję…' : 'Zapisz branding'}
          </button>
          {saved && <span className="text-sm shrink-0" style={{ color: 'var(--sig-teal)' }}>Zapisano!</span>}
        </div>
      </div>

      {/* ── Live preview panel ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-2 shrink-0 flex items-center gap-2" style={{ background: 'var(--sig-surface)', borderBottom: '1px solid var(--sig-border)' }}>
          <span className="w-2 h-2 rounded-full" style={{ background: 'var(--sig-teal)', animation: 'orbGlow 2s ease-in-out infinite' }} />
          <span className="font-mono text-xs font-medium" style={{ color: 'var(--sig-text)' }}>Podgląd na żywo</span>
          <span className="text-xs ml-1" style={{ color: 'var(--sig-text-muted)' }}>— zmiany widoczne przed zapisaniem</span>
        </div>
        <div className="flex-1 overflow-auto">
          <LivePreview form={form} logoUrl={currentLogoUrl} />
        </div>
      </div>
    </div>
  )
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--sig-text-muted)' }}>{title}</p>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs mb-1.5" style={{ color: 'var(--sig-text-muted)' }}>{label}</label>
      {children}
    </div>
  )
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value.startsWith('rgba') ? '#000000' : value}
          onChange={(e) => onChange(e.target.value)}
          className="w-8 h-8 rounded-md cursor-pointer shrink-0 p-0.5"
          style={{ border: '1px solid var(--sig-border)', background: 'rgba(8,13,24,0.8)' }}
        />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={25}
          className="input-sig font-mono text-xs"
        />
      </div>
    </Field>
  )
}

// ── Live preview ───────────────────────────────────────────────────────────────

function LivePreview({ form, logoUrl }: { form: BrandingForm; logoUrl: string | null }) {
  const v = form
  const vars = {
    '--bsp-bg': v.backgroundColor,
    '--bsp-card-bg': v.cardBackground,
    '--bsp-card-border': v.cardBorderColor,
    '--bsp-text': v.textColor,
    '--bsp-text-muted': v.textMutedColor,
    '--bsp-primary': v.primaryColor,
    '--bsp-accent': v.accentColor,
    '--bsp-up': v.statusUpColor,
    '--bsp-down': v.statusDownColor,
    '--bsp-degraded': v.statusDegradedColor,
  } as React.CSSProperties

  const card: React.CSSProperties = {
    borderRadius: '8px',
    padding: '10px 14px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  }

  const dot = (color: string): React.CSSProperties => ({
    width: '8px', height: '8px', borderRadius: '50%',
    background: color, display: 'inline-block', flexShrink: 0,
  })

  const badge: React.CSSProperties = {
    fontSize: '9px', color: v.textMutedColor,
    background: `${v.cardBorderColor}aa`,
    padding: '1px 5px', borderRadius: '3px', textTransform: 'uppercase',
  }

  const monitors: Array<{ name: string; type: string; status: 'up' | 'down' | 'degraded' | 'pending' }> = [
    { name: 'API Server', type: 'https', status: 'up' },
    { name: 'Database', type: 'ping', status: 'down' },
    { name: 'CDN', type: 'https', status: 'degraded' },
  ]

  const statusColor = { up: v.statusUpColor, down: v.statusDownColor, degraded: v.statusDegradedColor, pending: v.textMutedColor }
  const statusLabel = { up: 'Operational', down: 'Down', degraded: 'Degraded', pending: 'Checking' }

  const brandingStyles = `
.bsp-monitor-card { background: ${v.cardBackground}; border: 1px solid ${v.cardBorderColor}; border-radius: 8px; overflow: hidden; }
.bsp-group-card { background: ${v.cardBackground}; border: 1px solid ${v.cardBorderColor}; }
.bsp-monitor-name { color: ${v.textColor}; }
.bsp-group-label { color: ${v.textColor}; }
.bsp-site-name { color: ${v.textColor}; }
.bsp-divider { border-top-color: ${v.cardBorderColor}; }
.bsp-footer { color: ${v.textMutedColor}; border-top-color: ${v.cardBorderColor}; }
.bsp-text-block { color: ${v.textMutedColor}; }
`

  return (
    <div className="bsp-page" style={{ ...vars, background: v.backgroundColor, minHeight: '100%' }}>
      <style>{brandingStyles}</style>
      {v.customCss && <style>{v.customCss}</style>}
      <div style={{ maxWidth: '680px', margin: '0 auto', padding: '32px 20px', display: 'flex', flexDirection: 'column', gap: '24px' }}>

        {/* Header */}
        <header className="bsp-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
            {logoUrl && <img src={logoUrl} alt="" style={{ height: '28px', objectFit: 'contain' }} />}
            <span className="bsp-site-name" style={{ fontSize: '20px', fontWeight: 700, color: v.textColor }}>
              {v.siteName || 'Status Page'}
            </span>
          </div>
          <div
            className="bsp-status-banner"
            style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              background: `${v.statusUpColor}1a`,
              border: `1px solid ${v.statusUpColor}44`,
              borderRadius: '12px', padding: '12px 16px',
            }}
          >
            <span style={dot(v.statusUpColor)} />
            <span style={{ fontWeight: 600, color: v.textColor, fontSize: '14px' }}>All Systems Operational</span>
          </div>
        </header>

        {/* Standalone monitors */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {monitors.map((m) => (
            <div key={m.name} className="bsp-monitor-card" style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={dot(statusColor[m.status])} />
                <span className="bsp-monitor-name" style={{ fontSize: '13px', color: v.textColor }}>{m.name}</span>
                <span className="bsp-monitor-type" style={badge}>{m.type}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {m.status === 'up' && (
                  <span className="bsp-uptime-bar" style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
                    {Array.from({ length: 20 }, (_, i) => (
                      <span key={i} style={{ width: '4px', height: '16px', borderRadius: '2px', background: i < 18 ? v.statusUpColor : v.statusDownColor }} />
                    ))}
                  </span>
                )}
                <span className="bsp-monitor-status" style={{ fontSize: '11px', color: statusColor[m.status] }}>
                  {statusLabel[m.status]}
                </span>
              </div>
            </div>
          ))}
        </section>

        {/* Group */}
        <div className="bsp-group-card" style={{ borderRadius: '12px', overflow: 'hidden' }}>
          <div
            className="bsp-group-header"
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ ...dot(v.statusUpColor), width: '10px', height: '10px' }} />
              <span className="bsp-group-label" style={{ fontWeight: 500, fontSize: '14px', color: v.textColor }}>Infrastructure</span>
            </div>
            <span style={{ fontSize: '12px', color: v.statusUpColor }}>Operational</span>
          </div>
          {['Web Server', 'Load Balancer', 'Object Storage'].map((name, i) => (
            <div
              key={name}
              className="bsp-monitor-card"
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 16px 10px 28px',
                borderTop: `1px solid ${v.cardBorderColor}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={dot(i === 1 ? v.statusDegradedColor : v.statusUpColor)} />
                <span className="bsp-monitor-name" style={{ fontSize: '13px', color: v.textColor }}>{name}</span>
              </div>
              <span className="bsp-monitor-status" style={{ fontSize: '11px', color: i === 1 ? v.statusDegradedColor : v.statusUpColor }}>
                {i === 1 ? 'Degraded' : 'Operational'}
              </span>
            </div>
          ))}
        </div>

        {/* Text block example */}
        <div className="bsp-text-block" style={{ color: v.textMutedColor, fontSize: '13px', lineHeight: 1.6 }}>
          <strong style={{ color: v.textColor }}>Scheduled maintenance</strong> — window on Sunday 02:00–04:00 UTC.
        </div>

        {/* Divider */}
        <hr className="bsp-divider" style={{ border: 'none', borderTop: `1px solid ${v.cardBorderColor}` }} />

        {/* Footer */}
        <footer className="bsp-footer" style={{ textAlign: 'center', fontSize: '11px', color: v.textMutedColor }}>
          Last updated: {new Date().toLocaleTimeString()}
        </footer>
      </div>
    </div>
  )
}
