import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DEFAULT_BRANDING_COLORS, type Branding } from '@bsp/shared'
import { api } from '../api/client'

interface BrandingForm {
  enabled: boolean
  siteName: string
  logoType: 'image' | 'text'
  logoText: string
  logoUrl: string | null | undefined
  logoLightUrl: string | null | undefined
  logoDarkUrl: string | null | undefined
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
  elevatedBackground: string
  chartBackground: string
  chartGridColor: string
  customCss: string
}

const DEFAULTS: BrandingForm = {
  enabled: false,
  siteName: 'Status Page',
  logoType: 'image',
  logoText: '',
  logoUrl: undefined,
  logoLightUrl: undefined,
  logoDarkUrl: undefined,
  ...DEFAULT_BRANDING_COLORS,
  customCss: '',
}

const PREVIEW_SRC = window.location.port === '5173'
  ? `${window.location.protocol}//${window.location.hostname}:5174/?branding-preview=1`
  : '/?branding-preview=1'

type LogoSlot = 'custom' | 'light' | 'dark'
const LOGO_FIELDS = { custom: 'logoUrl', light: 'logoLightUrl', dark: 'logoDarkUrl' } as const
const LOGO_ENDPOINTS = { custom: '/admin/branding/logo', light: '/admin/branding/logo/light', dark: '/admin/branding/logo/dark' } as const

export default function BrandingPage() {
  const qc = useQueryClient()
  const previewFrame = useRef<HTMLIFrameElement>(null)
  const { data: branding } = useQuery<Branding>({
    queryKey: ['branding'],
    queryFn: () => api.get('/admin/branding'),
  })
  const [form, setForm] = useState<BrandingForm>(DEFAULTS)
  const [logoFiles, setLogoFiles] = useState<Record<LogoSlot, File | null>>({ custom: null, light: null, dark: null })
  const [logoPreviews, setLogoPreviews] = useState<Record<LogoSlot, string | null>>({ custom: null, light: null, dark: null })
  const [cssEditorOpen, setCssEditorOpen] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!branding) return
    setForm({
      enabled: !!branding.enabled,
      siteName: branding.siteName,
      logoType: branding.logoType === 'text' ? 'text' : 'image',
      logoText: branding.logoText ?? '',
      logoUrl: branding.logoUrl,
      logoLightUrl: branding.logoLightUrl,
      logoDarkUrl: branding.logoDarkUrl,
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
      elevatedBackground: branding.elevatedBackground ?? DEFAULTS.elevatedBackground,
      chartBackground: branding.chartBackground ?? DEFAULTS.chartBackground,
      chartGridColor: branding.chartGridColor ?? DEFAULTS.chartGridColor,
      customCss: branding.customCss ?? '',
    })
  }, [branding])

  const currentLogoUrl = form.logoUrl === null ? null : logoPreviews.custom ?? branding?.logoUrl ?? null
  const currentLightLogoUrl = form.logoLightUrl === null ? null : logoPreviews.light ?? branding?.logoLightUrl ?? null
  const currentDarkLogoUrl = form.logoDarkUrl === null ? null : logoPreviews.dark ?? branding?.logoDarkUrl ?? null

  const previewBranding = useMemo<Branding>(() => ({
    id: branding?.id ?? 1,
    faviconUrl: branding?.faviconUrl ?? null,
    updatedAt: branding?.updatedAt ?? Date.now(),
    ...form,
    enabled: form.enabled ? 1 : 0,
    logoText: form.logoText || null,
    logoUrl: currentLogoUrl,
    logoLightUrl: currentLightLogoUrl,
    logoDarkUrl: currentDarkLogoUrl,
    customCss: form.customCss || null,
  }), [branding?.faviconUrl, branding?.id, branding?.updatedAt, currentDarkLogoUrl, currentLightLogoUrl, currentLogoUrl, form])

  const sendPreview = useCallback(() => {
    const target = previewFrame.current?.contentWindow
    if (!target) return
    const targetOrigin = new URL(PREVIEW_SRC, window.location.href).origin
    target.postMessage({ type: 'bsp:branding-preview', branding: previewBranding }, targetOrigin)
  }, [previewBranding])

  useEffect(() => { sendPreview() }, [sendPreview])
  useEffect(() => {
    const ready = (event: MessageEvent) => {
      if (event.source === previewFrame.current?.contentWindow && event.data?.type === 'bsp:branding-preview-ready') sendPreview()
    }
    window.addEventListener('message', ready)
    return () => window.removeEventListener('message', ready)
  }, [sendPreview])

  const saveMutation = useMutation({
    mutationFn: async () => {
      await api.patch('/admin/branding', {
        ...form,
        enabled: form.enabled ? 1 : 0,
        customCss: form.customCss || null,
        logoText: form.logoText || null,
        ...(form.logoUrl === null ? { logoUrl: null } : {}),
        ...(form.logoLightUrl === null ? { logoLightUrl: null } : {}),
        ...(form.logoDarkUrl === null ? { logoDarkUrl: null } : {}),
      })
      for (const slot of Object.keys(logoFiles) as LogoSlot[]) {
        const file = logoFiles[slot]
        if (!file) continue
        const data = new FormData()
        data.append('file', file)
        await api.upload(LOGO_ENDPOINTS[slot], data)
      }
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['branding'] })
      setLogoFiles({ custom: null, light: null, dark: null })
      setLogoPreviews({ custom: null, light: null, dark: null })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  function selectLogo(slot: LogoSlot, file: File | null) {
    setLogoFiles((current) => ({ ...current, [slot]: file }))
    if (!file) {
      setLogoPreviews((current) => ({ ...current, [slot]: null }))
      return
    }
    const field = LOGO_FIELDS[slot]
    setForm((current) => ({ ...current, [field]: undefined }))
    const reader = new FileReader()
    reader.onload = () => setLogoPreviews((current) => ({ ...current, [slot]: String(reader.result) }))
    reader.readAsDataURL(file)
  }

  function removeLogo(slot: LogoSlot) {
    selectLogo(slot, null)
    const field = LOGO_FIELDS[slot]
    setForm((current) => ({ ...current, [field]: null }))
  }

  const set = (key: keyof BrandingForm) => (value: string) => setForm((current) => ({ ...current, [key]: value }))

  return (
    <div className="flex h-full overflow-hidden">
      <div className="w-80 shrink-0 flex flex-col overflow-hidden" style={{ background: 'var(--m3-surface-container-low)', borderRight: '1px solid var(--m3-outline-variant)' }}>
        <div className="px-5 py-4 shrink-0" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
          <h2 className="font-headline font-bold text-base" style={{ color: 'var(--m3-on-surface)' }}>Branding</h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--m3-secondary)' }}>Public status page appearance</p>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--m3-secondary)' }}>Identity</p>
            <div className="space-y-3">
              <Field label="Site name">
                <input value={form.siteName} onChange={(event) => set('siteName')(event.target.value)} className="input-sig" placeholder="My Status Page" />
                <p className="text-[10px] mt-1.5 leading-relaxed" style={{ color: 'var(--m3-secondary)' }}>Used in the browser tab title and page footer. It does not replace the logo.</p>
              </Field>
              <Field label="Logo">
                <div className="flex gap-1 p-0.5 rounded-lg mb-3" style={{ background: 'var(--m3-surface-container)' }}>
                  {(['image', 'text'] as const).map((type) => <button key={type} type="button" onClick={() => setForm((current) => ({ ...current, logoType: type }))} className="flex-1 text-xs py-1.5 rounded-md font-semibold transition-all" style={{ background: form.logoType === type ? 'var(--m3-surface-container-lowest)' : 'transparent', color: form.logoType === type ? 'var(--m3-on-surface)' : 'var(--m3-secondary)', boxShadow: form.logoType === type ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>{type === 'image' ? 'Image' : 'Text'}</button>)}
                </div>
                {form.logoType === 'image' ? (
                  form.enabled ? (
                    <LogoInput id="branding-logo-custom" label="Universal logo" url={currentLogoUrl} file={logoFiles.custom} onSelect={(file) => selectLogo('custom', file)} onRemove={() => removeLogo('custom')} />
                  ) : (
                    <div className="space-y-4">
                      <LogoInput id="branding-logo-light" label="Light mode logo" url={currentLightLogoUrl} file={logoFiles.light} onSelect={(file) => selectLogo('light', file)} onRemove={() => removeLogo('light')} />
                      <LogoInput id="branding-logo-dark" label="Dark mode logo" url={currentDarkLogoUrl} file={logoFiles.dark} onSelect={(file) => selectLogo('dark', file)} onRemove={() => removeLogo('dark')} />
                    </div>
                  )
                ) : <input value={form.logoText} onChange={(event) => setForm((current) => ({ ...current, logoText: event.target.value }))} className="input-sig" placeholder="e.g. Acme Corp" maxLength={40} />}
              </Field>
            </div>
          </div>

          <div className="flex items-center justify-between px-4 py-3 rounded-xl" style={{ background: form.enabled ? 'rgba(34,197,94,0.08)' : 'var(--m3-surface-container)', border: `1px solid ${form.enabled ? 'rgba(34,197,94,0.3)' : 'var(--m3-outline-variant)'}` }}>
            <div><p className="text-sm font-semibold">Custom branding</p><p className="text-xs mt-0.5" style={{ color: 'var(--m3-secondary)' }}>{form.enabled ? 'Custom colors are active' : 'Default project colors are in use'}</p></div>
            <button type="button" aria-label="Custom branding" aria-pressed={form.enabled} onClick={() => { setForm((current) => ({ ...current, enabled: !current.enabled })); setCssEditorOpen(false) }} className="relative flex-shrink-0 w-12 h-6 rounded-full transition-colors" style={{ background: form.enabled ? '#22c55e' : 'var(--m3-outline-variant)' }}><span className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform" style={{ transform: form.enabled ? 'translateX(22px)' : 'translateX(0)' }} /></button>
          </div>

          <fieldset disabled={!form.enabled} className="min-w-0 border-0 p-0 m-0 space-y-6 transition-opacity" style={{ opacity: form.enabled ? 1 : 0.45 }}>
          <Section title="Backgrounds">
            <ColorField label="Page background" value={form.backgroundColor} onChange={set('backgroundColor')} />
            <ColorField label="Cards and groups" value={form.cardBackground} onChange={set('cardBackground')} />
            <ColorField label="Elevated elements and tooltips" value={form.elevatedBackground} onChange={set('elevatedBackground')} />
            <ColorField label="Charts" value={form.chartBackground} onChange={set('chartBackground')} />
          </Section>
          <Section title="Borders and charts">
            <ColorField label="Borders" value={form.cardBorderColor} onChange={set('cardBorderColor')} />
            <ColorField label="Chart grid lines" value={form.chartGridColor} onChange={set('chartGridColor')} />
          </Section>
          <Section title="Text">
            <ColorField label="Primary text" value={form.textColor} onChange={set('textColor')} />
            <ColorField label="Secondary text" value={form.textMutedColor} onChange={set('textMutedColor')} />
          </Section>
          <Section title="Status colors">
            <ColorField label="Operational (↑)" value={form.statusUpColor} onChange={set('statusUpColor')} />
            <ColorField label="Down (↓)" value={form.statusDownColor} onChange={set('statusDownColor')} />
            <ColorField label="Degraded (~)" value={form.statusDegradedColor} onChange={set('statusDegradedColor')} />
          </Section>
          <Section title="Accent">
            <ColorField label="Primary color and chart line" value={form.primaryColor} onChange={set('primaryColor')} />
            <ColorField label="Accent color" value={form.accentColor} onChange={set('accentColor')} />
          </Section>
          <Section title="Custom CSS">
            <p className="text-[10px] mb-2 leading-relaxed" style={{ color: 'var(--m3-secondary)' }}>{form.enabled ? 'Open the full editor to customize the public page using documented classes and CSS variables.' : 'Enable custom branding to edit and apply custom CSS.'}</p>
            <button type="button" disabled={!form.enabled} onClick={() => setCssEditorOpen(true)} className="btn-primary w-full px-3 py-2.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 disabled:cursor-not-allowed"><span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: 17 }}>code</span>Open CSS editor</button>
            <p className="text-[10px]" style={{ color: 'var(--m3-secondary)' }}>{form.customCss ? `${form.customCss.split('\n').length} lines · ${form.customCss.length} characters` : 'No custom CSS yet'}</p>
          </Section>
          </fieldset>
        </div>

        <div className="px-5 py-4 shrink-0 flex items-center gap-3" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
          <button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="btn-primary flex-1 text-sm font-semibold py-2 rounded-lg">{saveMutation.isPending ? 'Saving…' : 'Save branding'}</button>
          {saved && <span className="text-sm shrink-0" style={{ color: 'var(--m3-primary)' }}>Saved!</span>}
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-2 shrink-0 flex items-center gap-2" style={{ background: 'var(--m3-surface-container-low)', borderBottom: '1px solid var(--m3-outline-variant)' }}>
          <span className="w-2 h-2 rounded-full" style={{ background: 'var(--m3-primary)', animation: 'orbGlow 2s ease-in-out infinite' }} />
          <span className="font-mono text-xs font-medium">Live preview</span>
          <span className="text-xs ml-1" style={{ color: 'var(--m3-secondary)' }}>— saved Page Builder layout with unsaved branding changes</span>
        </div>
        <iframe ref={previewFrame} src={PREVIEW_SRC} title="Public status page preview" onLoad={sendPreview} className="flex-1 w-full border-0" />
      </div>
      {form.enabled && cssEditorOpen && <CssEditorModal value={form.customCss} onChange={set('customCss')} onClose={() => setCssEditorOpen(false)} />}
    </div>
  )
}

function LogoInput({ id, label, url, file, onSelect, onRemove }: {
  id: string
  label: string
  url: string | null
  file: File | null
  onSelect: (file: File | null) => void
  onRemove: () => void
}) {
  return <div>
    <p className="text-[10px] font-semibold mb-1.5" style={{ color: 'var(--m3-secondary)' }}>{label}</p>
    {url && <div className="flex items-center gap-2 mb-2"><div className="h-12 min-w-24 max-w-48 flex items-center rounded-lg px-3" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}><img src={url} alt="Logo" className="max-h-9 max-w-full object-contain" /></div><button type="button" onClick={onRemove} className="px-2 py-1 rounded-lg text-xs" style={{ color: 'var(--m3-secondary)', background: 'var(--m3-surface-container)' }} aria-label="Remove logo">×</button></div>}
    <input id={id} type="file" accept="image/jpeg,image/png,image/gif,image/webp" onChange={(event) => onSelect(event.target.files?.[0] ?? null)} className="sr-only" />
    <div className="flex items-center gap-2 min-w-0"><label htmlFor={id} className="btn-primary shrink-0 px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer">Choose image</label><span className="text-xs truncate" style={{ color: 'var(--m3-secondary)' }} title={file?.name}>{file?.name ?? 'No file selected'}</span></div>
  </div>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="space-y-3"><p className="font-mono text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--m3-secondary)' }}>{title}</p><div className="space-y-2">{children}</div></div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="block text-xs mb-1.5" style={{ color: 'var(--m3-secondary)' }}>{label}</label>{children}</div>
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <Field label={label}><div className="flex items-center gap-2"><input type="color" value={value.startsWith('rgba') ? '#000000' : value} onChange={(event) => onChange(event.target.value)} className="w-8 h-8 rounded-md cursor-pointer shrink-0 p-0.5" style={{ border: '1px solid var(--m3-outline-variant)', background: 'var(--m3-surface-container-lowest)' }} /><input value={value} onChange={(event) => onChange(event.target.value)} maxLength={25} className="input-sig font-mono text-xs" /></div></Field>
}

const CSS_CLASSES = [
  ['.bsp-page', 'Entire public status page'],
  ['.bsp-header', 'Sticky page header'],
  ['.bsp-navigation', 'Header navigation content'],
  ['.bsp-content', 'Main page content'],
  ['.bsp-status-banner', 'Overall status badge'],
  ['.bsp-maintenance-banner', 'Maintenance notice'],
  ['.bsp-monitor-card', 'Monitor card'],
  ['.bsp-monitor-name', 'Monitor name'],
  ['.bsp-group-card', 'Monitor group'],
  ['.bsp-group-label', 'Group name'],
  ['.bsp-chart-card', 'Chart card and its background'],
  ['.bsp-chart', 'Chart content'],
  ['.bsp-chart-tooltip', 'Chart hover tooltip'],
  ['.bsp-text-block', 'Page Builder markdown block'],
  ['.bsp-divider', 'Page Builder divider'],
  ['.bsp-incidents-section', 'System events section'],
  ['.bsp-incident-card', 'Incident card or history row'],
  ['.bsp-footer', 'Page footer'],
] as const

const CSS_VARIABLES = [
  '--bsp-bg', '--bsp-card-bg', '--bsp-elevated-bg', '--bsp-card-border',
  '--bsp-text', '--bsp-text-muted', '--bsp-primary', '--bsp-accent',
  '--bsp-up', '--bsp-down', '--bsp-degraded', '--bsp-chart-bg', '--bsp-chart-grid',
] as const

function CssEditorModal({ value, onChange, onClose }: { value: string; onChange: (value: string) => void; onClose: () => void }) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  const gutter = useRef<HTMLDivElement>(null)
  const lineCount = Math.max(1, value.split('\n').length)

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    textarea.current?.focus()
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Tab') return
    event.preventDefault()
    const input = event.currentTarget
    const start = input.selectionStart
    const end = input.selectionEnd
    onChange(`${value.slice(0, start)}  ${value.slice(end)}`)
    requestAnimationFrame(() => {
      input.selectionStart = input.selectionEnd = start + 2
    })
  }

  return (
    <div className="fixed inset-0 z-[120] p-4 md:p-8 flex" role="dialog" aria-modal="true" aria-label="Custom CSS editor" style={{ background: 'rgba(0,0,0,0.65)' }}>
      <div className="flex-1 min-w-0 rounded-2xl overflow-hidden flex flex-col" style={{ background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)', boxShadow: '0 24px 80px rgba(0,0,0,0.35)' }}>
        <header className="px-5 py-4 flex items-center gap-4" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
          <span aria-hidden="true" className="material-symbols-outlined rounded-xl p-2" style={{ background: 'var(--admin-icon-container)', color: 'var(--admin-icon-color)' }}>code</span>
          <div><h2 className="font-headline text-lg font-semibold">Custom CSS editor</h2><p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>Changes are applied to the live preview immediately. Save branding when you are finished.</p></div>
          <button type="button" onClick={onClose} className="btn-primary ml-auto px-5 py-2 rounded-lg text-sm font-semibold">Done</button>
        </header>

        <div className="flex-1 min-h-0 grid lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-h-[420px] flex overflow-hidden" style={{ background: '#111318', color: '#e5e7eb' }}>
            <div ref={gutter} aria-hidden="true" className="py-4 px-3 text-right select-none overflow-hidden font-mono text-xs leading-6" style={{ minWidth: 48, color: '#6b7280', background: '#0b0d11', borderRight: '1px solid #2c3038' }}>
              {Array.from({ length: lineCount }, (_, index) => <div key={index}>{index + 1}</div>)}
            </div>
            <textarea
              ref={textarea}
              aria-label="Custom CSS"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={handleKeyDown}
              onScroll={(event) => { if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop }}
              spellCheck={false}
              className="flex-1 min-w-0 h-full resize-none outline-none border-0 p-4 font-mono text-xs leading-6"
              style={{ background: '#111318', color: '#e5e7eb', tabSize: 2 }}
              placeholder={'.bsp-monitor-card {\n  border-radius: 8px;\n}\n\n.bsp-chart-card {\n  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);\n}'}
            />
          </div>

          <aside className="overflow-y-auto p-5 space-y-6" style={{ background: 'var(--m3-surface-container-low)' }}>
            <section>
              <h3 className="font-semibold text-sm mb-2">Quick example</h3>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--m3-secondary)' }}>Custom branding uses one fixed appearance. Your selectors are applied directly to that branded page.</p>
              <pre className="mt-3 rounded-lg p-3 text-[11px] overflow-x-auto" style={{ background: 'var(--m3-surface-container-high)' }}>{`.bsp-page {\n  background-image: none;\n}`}</pre>
            </section>
            <section>
              <h3 className="font-semibold text-sm mb-3">Available classes</h3>
              <div className="space-y-2">{CSS_CLASSES.map(([name, description]) => <div key={name}><code className="font-mono text-xs" style={{ color: 'var(--m3-on-primary-container)' }}>{name}</code><p className="text-[11px]" style={{ color: 'var(--m3-secondary)' }}>{description}</p></div>)}</div>
            </section>
            <section>
              <h3 className="font-semibold text-sm mb-2">Branding variables</h3>
              <p className="text-xs mb-3" style={{ color: 'var(--m3-secondary)' }}>These variables contain the current custom branding palette.</p>
              <div className="flex flex-wrap gap-1.5">{CSS_VARIABLES.map((name) => <code key={name} className="font-mono text-[10px] px-2 py-1 rounded" style={{ background: 'var(--m3-surface-container-high)' }}>{name}</code>)}</div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}
