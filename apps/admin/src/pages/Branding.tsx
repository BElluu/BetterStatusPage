import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Branding } from '@bsp/shared'

interface BrandingForm {
  enabled: boolean
  siteName: string
  logoType: 'image' | 'text'
  logoText: string
  logoUrl?: string | null
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
  enabled: false,
  siteName: 'Status Page',
  logoType: 'image',
  logoText: '',
  primaryColor: '#5256a4',
  accentColor: '#5c5faa',
  backgroundColor: '#faf8ff',
  cardBackground: '#f2f0fd',
  cardBorderColor: '#c8c5d0',
  textColor: '#1b1b22',
  textMutedColor: '#5d5c72',
  statusUpColor: '#1a7f37',
  statusDownColor: '#c0392b',
  statusDegradedColor: '#b05c00',
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
        enabled: !!branding.enabled,
        siteName: branding.siteName,
        logoType: (branding.logoType as 'image' | 'text') ?? 'image',
        logoText: branding.logoText ?? '',
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
      await api.patch('/admin/branding', {
        ...form,
        enabled: form.enabled ? 1 : 0,
        customCss: form.customCss || null,
        logoText: form.logoText || null,
        ...(form.logoUrl === null ? { logoUrl: null } : {}),
      })
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

  const currentLogoUrl = form.logoUrl === null ? null : (logoPreviewUrl ?? branding?.logoUrl ?? null)

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Controls panel ── */}
      <div className="w-80 shrink-0 flex flex-col overflow-hidden" style={{ background: 'var(--m3-surface-container-low)', borderRight: '1px solid var(--m3-outline-variant)' }}>
        <div className="px-5 py-4 shrink-0" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
          <h2 className="font-headline font-bold text-base" style={{ color: 'var(--m3-on-surface)' }}>Branding</h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--m3-secondary)' }}>Public status page appearance</p>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">

          {/* Identity */}
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-widest mb-3 flex items-center gap-2" style={{ color: 'var(--m3-secondary)' }}>
              Identity
              <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(34,197,94,0.12)', color: '#16a34a' }}>always active</span>
            </p>
            <div className="space-y-2">
              <Field label="Site name">
                <input value={form.siteName} onChange={(e) => set('siteName')(e.target.value)}
                  className="input-sig" placeholder="My Status Page" />
              </Field>
              <Field label="Logo">
                {/* Logo type toggle */}
                <div className="flex gap-1 p-0.5 rounded-lg mb-2" style={{ background: 'var(--m3-surface-container)' }}>
                  {(['image', 'text'] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, logoType: type }))}
                      className="flex-1 text-xs py-1.5 rounded-md font-semibold transition-all"
                      style={{
                        background: form.logoType === type ? 'var(--m3-surface-container-lowest)' : 'transparent',
                        color: form.logoType === type ? 'var(--m3-on-surface)' : 'var(--m3-secondary)',
                        boxShadow: form.logoType === type ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                      }}
                    >
                      {type === 'image' ? 'Image' : 'Text'}
                    </button>
                  ))}
                </div>
                {form.logoType === 'image' ? (
                  <>
                    {currentLogoUrl && (
                      <div className="flex items-center gap-2 mb-2">
                        <img src={currentLogoUrl} alt="Logo" className="h-8 object-contain rounded px-2 py-1" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }} />
                        <button
                          type="button"
                          onClick={() => {
                            setLogoFile(null)
                            setLogoPreviewUrl(null)
                            setForm((f) => ({ ...f, logoUrl: null as unknown as string }))
                          }}
                          className="text-xs px-2 py-1 rounded-lg transition-colors"
                          style={{ color: 'var(--m3-secondary)', background: 'var(--m3-surface-container)' }}
                          title="Remove logo"
                        >
                          ×
                        </button>
                      </div>
                    )}
                    <input type="file" accept="image/*"
                      onChange={(e) => {
                        const file = e.target.files?.[0] ?? null
                        setLogoFile(file)
                        if (file) setLogoPreviewUrl(URL.createObjectURL(file))
                      }}
                      className="block text-xs cursor-pointer"
                      style={{ color: 'var(--m3-secondary)' }}
                    />
                  </>
                ) : (
                  <input
                    value={form.logoText}
                    onChange={(e) => setForm((f) => ({ ...f, logoText: e.target.value }))}
                    className="input-sig"
                    placeholder="e.g. Acme Corp"
                    maxLength={40}
                  />
                )}
              </Field>
            </div>
          </div>

          {/* ── Branding toggle ── */}
          <div
            className="flex items-center justify-between px-4 py-3 rounded-xl"
            style={{ background: form.enabled ? 'rgba(34,197,94,0.08)' : 'var(--m3-surface-container)', border: `1px solid ${form.enabled ? 'rgba(34,197,94,0.3)' : 'var(--m3-outline-variant)'}` }}
          >
            <div>
              <p className="font-sans text-sm font-semibold" style={{ color: 'var(--m3-on-surface)' }}>
                Custom branding
              </p>
              <p className="font-sans text-xs mt-0.5" style={{ color: 'var(--m3-secondary)' }}>
                {form.enabled ? 'Custom colors are active' : 'Default project colors are in use'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setForm((f) => ({ ...f, enabled: !f.enabled }))}
              className="relative flex-shrink-0 w-12 h-6 rounded-full transition-colors duration-200"
              style={{ background: form.enabled ? '#22c55e' : 'var(--m3-outline-variant)' }}
            >
              <span
                className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200"
                style={{ transform: form.enabled ? 'translateX(22px)' : 'translateX(0px)' }}
              />
            </button>
          </div>

          {/* Tło i karty */}
          <Section title="Background and cards">
            <ColorField label="Page background" value={form.backgroundColor} onChange={set('backgroundColor')} />
            <ColorField label="Card / element background" value={form.cardBackground} onChange={set('cardBackground')} />
            <ColorField label="Card border" value={form.cardBorderColor} onChange={set('cardBorderColor')} />
          </Section>

          {/* Tekst */}
          <Section title="Text">
            <ColorField label="Primary text" value={form.textColor} onChange={set('textColor')} />
            <ColorField label="Secondary text" value={form.textMutedColor} onChange={set('textMutedColor')} />
          </Section>

          {/* Statusy */}
          <Section title="Status colors">
            <ColorField label="Operational (↑)" value={form.statusUpColor} onChange={set('statusUpColor')} />
            <ColorField label="Down (↓)" value={form.statusDownColor} onChange={set('statusDownColor')} />
            <ColorField label="Degraded (~)" value={form.statusDegradedColor} onChange={set('statusDegradedColor')} />
          </Section>

          {/* Akcent */}
          <Section title="Accent">
            <ColorField label="Primary color" value={form.primaryColor} onChange={set('primaryColor')} />
            <ColorField label="Accent color" value={form.accentColor} onChange={set('accentColor')} />
          </Section>

          {/* Custom CSS */}
          <Section title="Custom CSS">
            <p className="text-[10px] text-slate-500 mb-2 leading-relaxed">
              Available classes:{' '}
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
              placeholder="/* e.g. .bsp-monitor-card { border-radius: 0; } */"
            />
          </Section>
        </div>

        {/* Save */}
        <div className="px-5 py-4 shrink-0 flex items-center gap-3" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="btn-primary flex-1 text-sm font-semibold py-2 rounded-lg transition-all"
            style={{
              background: saveMutation.isPending ? 'var(--m3-surface-container-high)' : 'var(--m3-primary)',
              color: saveMutation.isPending ? 'var(--m3-secondary)' : 'var(--m3-on-primary)',
              opacity: saveMutation.isPending ? 0.7 : 1,
            }}
          >
            {saveMutation.isPending ? 'Saving…' : 'Save branding'}
          </button>
          {saved && <span className="text-sm shrink-0" style={{ color: 'var(--m3-primary)' }}>Saved!</span>}
        </div>
      </div>

      {/* ── Live preview panel ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-2 shrink-0 flex items-center gap-2" style={{ background: 'var(--m3-surface-container-low)', borderBottom: '1px solid var(--m3-outline-variant)' }}>
          <span className="w-2 h-2 rounded-full" style={{ background: 'var(--m3-primary)', animation: 'orbGlow 2s ease-in-out infinite' }} />
          <span className="font-mono text-xs font-medium" style={{ color: 'var(--m3-on-surface)' }}>Live preview</span>
          <span className="text-xs ml-1" style={{ color: 'var(--m3-secondary)' }}>— changes are visible before saving</span>
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
      <p className="font-mono text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--m3-secondary)' }}>{title}</p>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs mb-1.5" style={{ color: 'var(--m3-secondary)' }}>{label}</label>
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
          style={{ border: '1px solid var(--m3-outline-variant)', background: 'var(--m3-surface-container-lowest)' }}
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

// Design system defaults (matches index.css --bsp-* aliases when branding disabled)
const DESIGN_DEFAULTS = {
  backgroundColor: '#f2f3ff',
  cardBackground: '#f2f3ff',
  cardBorderColor: '#c6c6cd',
  textColor: '#131b2e',
  textMutedColor: '#505f76',
  primaryColor: '#000000',
  accentColor: '#497cff',
  statusUpColor: '#22c55e',
  statusDownColor: '#ba1a1a',
  statusDegradedColor: '#eab308',
}

function LivePreview({ form, logoUrl }: { form: BrandingForm; logoUrl: string | null }) {
  const v = form.enabled ? form : { ...form, ...DESIGN_DEFAULTS }

  // Helper to generate status badge styles
  const statusBadge = (status: 'up' | 'down' | 'degraded') => ({
    up: { bg: `${v.statusUpColor}1a`, color: v.statusUpColor, label: 'Operational' },
    down: { bg: `${v.statusDownColor}20`, color: v.statusDownColor, label: 'Outage' },
    degraded: { bg: `${v.statusDegradedColor}18`, color: v.statusDegradedColor, label: 'Degraded' },
  }[status])

  // Lighten a hex color for gradient top (mix with white ~40%)
  function lighten(hex: string): string {
    const n = parseInt(hex.replace('#', ''), 16)
    const r = Math.min(255, ((n >> 16) & 0xff) + 80)
    const g = Math.min(255, ((n >> 8) & 0xff) + 80)
    const b = Math.min(255, (n & 0xff) + 80)
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
  }

  // Uptime bars row — gradient matching actual app
  const _UptimeBars = ({ color, barCount = 30 }: { color: string; barCount?: number }) => {
    const lightColor = lighten(color)
    return (
      <div style={{ display: 'flex', height: '40px', gap: '2px' }}>
        {Array.from({ length: barCount }).map((_, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              borderRadius: '2px',
              background: `linear-gradient(to top, ${color}, ${lightColor})`,
              opacity: i >= barCount - 3 ? 0.5 : 1,
            }}
          />
        ))}
      </div>
    )
  }

  // Full monitor card — 'right' position: bars inline between name and badge
  const MonitorCard = ({ name, type, status }: {
    name: string; type: string; status: 'up' | 'down' | 'degraded'
  }) => {
    const s = statusBadge(status)
    const barColor = status === 'up' ? v.statusUpColor : status === 'down' ? v.statusDownColor : v.statusDegradedColor
    const lightColor = lighten(barColor)
    return (
      <div style={{
        background: v.cardBackground,
        border: `1px solid ${v.cardBorderColor}`,
        borderRadius: '16px',
        padding: '28px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {/* Name + type */}
          <div style={{ flexShrink: 0 }}>
            <div style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 700, fontSize: '28px', color: v.textColor, lineHeight: 1.15 }}>
              {name}
            </div>
            <div style={{ fontFamily: 'monospace', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.09em', color: v.textMutedColor, marginTop: '4px' }}>
              {type}
            </div>
          </div>
          {/* Bars filling gap */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'stretch', gap: '2px', height: '48px' }}>
            {Array.from({ length: 30 }).map((_, i) => (
              <div key={i} style={{
                flex: 1,
                borderRadius: '3px',
                background: `linear-gradient(to top, ${barColor}, ${lightColor})`,
                opacity: i >= 27 ? 0.5 : 1,
              }} />
            ))}
          </div>
          {/* Badge */}
          <span style={{
            background: s.bg, color: s.color,
            padding: '6px 14px', borderRadius: '999px',
            fontSize: '13px', fontWeight: 700, flexShrink: 0,
          }}>
            {s.label}
          </span>
        </div>
      </div>
    )
  }

  // Compact row (group child)
  const CompactRow = ({ name, status }: { name: string; status: 'up' | 'down' | 'degraded' }) => {
    const s = statusBadge(status)
    const dotColor = status === 'up' ? v.statusUpColor : status === 'down' ? v.statusDownColor : v.statusDegradedColor
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '10px 20px',
        borderTop: `1px solid ${v.cardBorderColor}`,
      }}>
        <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: '13px', color: v.textColor, fontWeight: 500 }}>{name}</span>
        <span style={{ fontSize: '11px', fontWeight: 600, padding: '3px 10px', borderRadius: '999px', background: s.bg, color: s.color }}>
          {s.label}
        </span>
      </div>
    )
  }

  return (
    <div style={{ background: v.backgroundColor, minHeight: '100%', fontFamily: 'Inter, sans-serif' }}>
      {v.customCss && <style>{v.customCss}</style>}

      {/* Nav */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '16px 32px',
        borderBottom: `1px solid ${v.cardBorderColor}`,
        background: v.backgroundColor,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {form.logoType === 'text' && form.logoText ? (
            <span style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: '16px', color: v.textColor }}>
              {form.logoText}
            </span>
          ) : logoUrl ? (
            <img src={logoUrl} alt="" style={{ height: '22px', objectFit: 'contain' }} />
          ) : null}
          {!(form.logoType === 'text' && form.logoText) && (
            <span style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: '16px', color: v.textColor }}>
              {v.siteName || 'Status Page'}
            </span>
          )}
        </div>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: '8px',
          padding: '5px 14px', borderRadius: '999px',
          background: `${v.statusUpColor}15`,
          fontSize: '11px', fontWeight: 600, color: v.statusUpColor,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: v.statusUpColor, display: 'inline-block' }} />
          All systems operational
        </div>
      </div>

      {/* Hero */}
      <div style={{ textAlign: 'center', padding: '32px 32px 24px' }}>
        <div style={{
          fontFamily: 'Manrope, sans-serif', fontWeight: 800,
          fontSize: '36px', lineHeight: 1.1,
          color: v.textColor, marginBottom: '8px',
        }}>
          All systems operational.
        </div>
        <div style={{ fontSize: '13px', color: v.textMutedColor }}>
          3 services monitored in real time.
        </div>
      </div>

      {/* Cards grid */}
      <div style={{ padding: '0 32px 32px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

        {/* Two monitor cards side by side */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          <MonitorCard name="API Engine" type="HTTPS" status="up" />
          <MonitorCard name="Web Console" type="HTTPS" status="degraded" />
        </div>

        {/* Group card */}
        <div style={{
          background: v.cardBackground,
          border: `1px solid ${v.cardBorderColor}`,
          borderRadius: '16px',
          overflow: 'hidden',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '9px', height: '9px', borderRadius: '50%', background: v.statusUpColor }} />
              <span style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 600, fontSize: '14px', color: v.textColor }}>
                Infrastructure
              </span>
              <span style={{ fontSize: '11px', color: v.textMutedColor }}>3 services</span>
            </div>
            <span style={{ fontSize: '11px', fontWeight: 600, padding: '3px 10px', borderRadius: '999px', background: `${v.statusUpColor}1a`, color: v.statusUpColor }}>
              Operational
            </span>
          </div>
          <CompactRow name="Primary DB Cluster" status="up" />
          <CompactRow name="Cache Layer" status="degraded" />
          <CompactRow name="Object Storage" status="up" />
        </div>

        {/* Active incident card */}
        <div style={{
          background: v.cardBackground,
          borderRadius: '24px',
          padding: '28px',
          borderLeft: `4px solid ${v.statusDegradedColor}`,
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '28px' }}>
            <div style={{ fontSize: '11px', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.07em', color: v.textMutedColor }}>
              Jun 14, 2026<br />14:20 UTC
            </div>
            <div>
              <span style={{
                display: 'inline-block', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
                padding: '3px 10px', borderRadius: '999px', marginBottom: '10px',
                background: `${v.statusDegradedColor}15`, color: v.statusDegradedColor,
              }}>
                Investigating
              </span>
              <div style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 700, fontSize: '18px', color: v.textColor, marginBottom: '12px' }}>
                Elevated latency in EU region
              </div>
              <div style={{ borderLeft: `2px solid ${v.cardBorderColor}`, paddingLeft: '20px' }}>
                <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: v.statusDegradedColor, marginBottom: '4px' }}>
                  14:20 UTC — Investigating
                </div>
                <div style={{ fontSize: '12px', color: v.textColor }}>
                  We are investigating reports of elevated response times affecting EU endpoints.
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ textAlign: 'center', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.1em', color: v.textMutedColor, paddingTop: '8px' }}>
          {v.siteName || 'Status Page'}
        </div>
      </div>
    </div>
  )
}
