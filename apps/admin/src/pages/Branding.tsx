import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DEFAULT_BRANDING_COLORS, DEFAULT_UPTIME_THRESHOLDS, validateUptimeThresholds, type Branding, type UptimeThresholds } from '@bsp/shared'
import { api } from '../api/client'
import { ModalShell } from '../components/ModalShell'
import { Field, Switch } from '../components/ui'

interface BrandingForm {
  enabled: boolean
  showHero: boolean
  showFooter: boolean
  showProjectLink: boolean
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
  statusPartialColor: string
  elevatedBackground: string
  chartBackground: string
  chartGridColor: string
  customCss: string
  // Kept as typed text so a field can be cleared while editing; parsed on preview and save.
  uptimeThresholdUp: string
  uptimeThresholdDegraded: string
  uptimeThresholdPartial: string
}

const DEFAULTS: BrandingForm = {
  enabled: false,
  showHero: true,
  showFooter: true,
  showProjectLink: true,
  siteName: 'Status Page',
  logoType: 'image',
  logoText: '',
  logoUrl: undefined,
  logoLightUrl: undefined,
  logoDarkUrl: undefined,
  ...DEFAULT_BRANDING_COLORS,
  customCss: '',
  uptimeThresholdUp: String(DEFAULT_UPTIME_THRESHOLDS.uptimeThresholdUp),
  uptimeThresholdDegraded: String(DEFAULT_UPTIME_THRESHOLDS.uptimeThresholdDegraded),
  uptimeThresholdPartial: String(DEFAULT_UPTIME_THRESHOLDS.uptimeThresholdPartial),
}

/** The Layout switches as the 0/1 flags the API stores. */
function layoutSwitches(form: BrandingForm) {
  return {
    showHero: form.showHero ? 1 : 0,
    showFooter: form.showFooter ? 1 : 0,
    showProjectLink: form.showProjectLink ? 1 : 0,
  }
}

function parseThresholds(form: BrandingForm): UptimeThresholds {
  const parse = (value: string) => value.trim() === '' ? Number.NaN : Number(value)
  return {
    uptimeThresholdUp: parse(form.uptimeThresholdUp),
    uptimeThresholdDegraded: parse(form.uptimeThresholdDegraded),
    uptimeThresholdPartial: parse(form.uptimeThresholdPartial),
  }
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
  // Set once the user edits the form; until then (and again after a save) the loaded branding may
  // replace it. Without this, edits made before the first load finishes are silently overwritten.
  const edited = useRef(false)
  const editForm: typeof setForm = (update) => { edited.current = true; setForm(update) }

  useEffect(() => {
    if (!branding || edited.current) return
    setForm({
      enabled: !!branding.enabled,
      showHero: (branding.showHero ?? 1) === 1,
      showFooter: (branding.showFooter ?? 1) === 1,
      showProjectLink: (branding.showProjectLink ?? 1) === 1,
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
      statusPartialColor: branding.statusPartialColor ?? DEFAULTS.statusPartialColor,
      elevatedBackground: branding.elevatedBackground ?? DEFAULTS.elevatedBackground,
      chartBackground: branding.chartBackground ?? DEFAULTS.chartBackground,
      chartGridColor: branding.chartGridColor ?? DEFAULTS.chartGridColor,
      customCss: branding.customCss ?? '',
      uptimeThresholdUp: String(branding.uptimeThresholdUp ?? DEFAULTS.uptimeThresholdUp),
      uptimeThresholdDegraded: String(branding.uptimeThresholdDegraded ?? DEFAULTS.uptimeThresholdDegraded),
      uptimeThresholdPartial: String(branding.uptimeThresholdPartial ?? DEFAULTS.uptimeThresholdPartial),
    })
  }, [branding])

  const currentLogoUrl = form.logoUrl === null ? null : logoPreviews.custom ?? branding?.logoUrl ?? null
  const currentLightLogoUrl = form.logoLightUrl === null ? null : logoPreviews.light ?? branding?.logoLightUrl ?? null
  const currentDarkLogoUrl = form.logoDarkUrl === null ? null : logoPreviews.dark ?? branding?.logoDarkUrl ?? null

  const thresholds = parseThresholds(form)
  const thresholdError = validateUptimeThresholds(thresholds)

  const previewBranding = useMemo<Branding>(() => ({
    id: branding?.id ?? 1,
    faviconUrl: branding?.faviconUrl ?? null,
    updatedAt: branding?.updatedAt ?? Date.now(),
    ...form,
    ...parseThresholds(form),
    enabled: form.enabled ? 1 : 0,
    ...layoutSwitches(form),
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
        ...parseThresholds(form),
        enabled: form.enabled ? 1 : 0,
        ...layoutSwitches(form),
        customCss: form.customCss || null,
        logoText: form.logoText || null,
        ...(form.logoUrl === null ? { logoUrl: null } : {}),
        ...(form.logoLightUrl === null ? { logoLightUrl: null } : {}),
        ...(form.logoDarkUrl === null ? { logoDarkUrl: null } : {}),
      })
      const activeLogoSlots: LogoSlot[] = form.enabled ? ['custom'] : ['light', 'dark']
      for (const slot of activeLogoSlots) {
        const file = logoFiles[slot]
        if (!file) continue
        const data = new FormData()
        data.append('file', file)
        await api.upload(LOGO_ENDPOINTS[slot], data)
      }
    },
    onSuccess: async () => {
      edited.current = false
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
    editForm((current) => ({ ...current, [field]: undefined }))
    const reader = new FileReader()
    reader.onload = () => setLogoPreviews((current) => ({ ...current, [slot]: String(reader.result) }))
    reader.readAsDataURL(file)
  }

  function removeLogo(slot: LogoSlot) {
    selectLogo(slot, null)
    const field = LOGO_FIELDS[slot]
    editForm((current) => ({ ...current, [field]: null }))
  }

  function toggleBranding() {
    const enabled = !form.enabled
    const resetSlots: LogoSlot[] = enabled ? ['light', 'dark'] : ['custom']
    setLogoFiles((current) => ({ ...current, ...Object.fromEntries(resetSlots.map((slot) => [slot, null])) }))
    setLogoPreviews((current) => ({ ...current, ...Object.fromEntries(resetSlots.map((slot) => [slot, null])) }))
    editForm((current) => ({
      ...current,
      enabled,
      ...(enabled
        ? { logoLightUrl: branding?.logoLightUrl, logoDarkUrl: branding?.logoDarkUrl }
        : { logoUrl: branding?.logoUrl }),
    }))
    setCssEditorOpen(false)
  }

  // The public page uses the default palette while custom branding is off.
  const statusColor = (key: 'statusUpColor' | 'statusDegradedColor' | 'statusPartialColor' | 'statusDownColor') =>
    form.enabled ? form[key] : DEFAULTS[key]

  const set = (key: keyof BrandingForm) => (value: string) => editForm((current) => ({ ...current, [key]: value }))

  return (
    <div className="flex h-full overflow-hidden">
      <div className="w-80 shrink-0 flex flex-col overflow-hidden" style={{ background: 'var(--m3-surface-container-low)', borderRight: '1px solid var(--m3-outline-variant)' }}>
        <div className="px-5 py-4 shrink-0" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
          <h1 className="font-headline font-bold text-base" style={{ color: 'var(--m3-on-surface)' }}>Branding</h1>
          <p className="text-xs mt-0.5" style={{ color: 'var(--m3-secondary)' }}>Public status page appearance</p>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--m3-secondary)' }}>Identity</p>
            <div className="space-y-3">
              <Field label="Site name" variant="plain" hint="Used in the browser tab title and page footer. It does not replace the logo.">
                <input value={form.siteName} onChange={(event) => set('siteName')(event.target.value)} className="input-sig" placeholder="My Status Page" />
              </Field>
              <div role="group" aria-labelledby="branding-logo-label">
                <p id="branding-logo-label" className="block text-xs mb-1.5" style={{ color: 'var(--m3-secondary)' }}>Logo</p>
                <div className="flex gap-1 p-0.5 rounded-lg mb-3" style={{ background: 'var(--m3-surface-container)' }}>
                  {(['image', 'text'] as const).map((type) => <button key={type} type="button" aria-pressed={form.logoType === type} onClick={() => editForm((current) => ({ ...current, logoType: type }))} className="flex-1 text-xs py-1.5 rounded-md font-semibold transition-all focus-ring" style={{ background: form.logoType === type ? 'var(--m3-surface-container-lowest)' : 'transparent', color: form.logoType === type ? 'var(--m3-on-surface)' : 'var(--m3-secondary)', boxShadow: form.logoType === type ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>{type === 'image' ? 'Image' : 'Text'}</button>)}
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
                ) : <input value={form.logoText} onChange={(event) => editForm((current) => ({ ...current, logoText: event.target.value }))} aria-label="Logo text" className="input-sig" placeholder="e.g. Acme Corp" maxLength={40} />}
              </div>
            </div>
          </div>

          <Section title="Layout">
            <Switch
              checked={form.showHero}
              onChange={(showHero) => editForm((current) => ({ ...current, showHero }))}
              label="Page header"
              description="The overall status headline and monitor count above the page. Turn it off to give monitors more room."
            />
            <Switch
              checked={form.showFooter}
              onChange={(showFooter) => editForm((current) => ({ ...current, showFooter }))}
              label="Footer"
              description="The logo and site name at the bottom of the page."
            />
            <Switch
              checked={form.showProjectLink}
              onChange={(showProjectLink) => editForm((current) => ({ ...current, showProjectLink }))}
              label="BetterStatusPage link"
              description={form.showProjectLink
                ? 'A small link to the project in the bottom-right corner. Thank you for keeping it! ❤'
                : 'Hidden. No hard feelings. Well, maybe a few.'}
            />
          </Section>

          <Section title="Uptime bar">
            <p className="text-[10px] leading-relaxed" style={{ color: 'var(--m3-secondary)' }}>Minimum daily uptime for each colour of the uptime bar. Applies to every monitor, with or without custom branding. Failures below a monitor's failure threshold are not counted.</p>
            <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--m3-outline-variant)' }}>
              <ThresholdRow color={statusColor('statusUpColor')} label="Operational" operator="≥" value={form.uptimeThresholdUp} onChange={set('uptimeThresholdUp')} first />
              <ThresholdRow color={statusColor('statusDegradedColor')} label="Degraded" operator="≥" value={form.uptimeThresholdDegraded} onChange={set('uptimeThresholdDegraded')} />
              <ThresholdRow color={statusColor('statusPartialColor')} label="Partial outage" operator="≥" value={form.uptimeThresholdPartial} onChange={set('uptimeThresholdPartial')} />
              <ThresholdRow color={statusColor('statusDownColor')} label="Down" operator="<" value={form.uptimeThresholdPartial} />
            </div>
            <p className="text-[10px]" style={{ color: 'var(--m3-secondary)' }}>Values in % of successful checks per day. The Down limit follows Partial outage.</p>
            {thresholdError && <p role="alert" className="text-xs" style={{ color: 'var(--m3-error)' }}>{thresholdError}</p>}
          </Section>

          <Switch
            checked={form.enabled}
            onChange={toggleBranding}
            label="Custom branding"
            description={form.enabled ? 'Custom colors are active' : 'Default project colors are in use'}
            className="items-center px-4 py-3 rounded-xl bg-surface-container border border-outline-variant"
          />

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
            <ColorField label="Partial outage (uptime bar)" value={form.statusPartialColor} onChange={set('statusPartialColor')} />
          </Section>
          <Section title="Accent">
            <ColorField label="Primary color and chart line" value={form.primaryColor} onChange={set('primaryColor')} />
            <ColorField label="Accent color" value={form.accentColor} onChange={set('accentColor')} />
          </Section>
          <Section title="Custom CSS">
            <p className="text-[10px] mb-2 leading-relaxed" style={{ color: 'var(--m3-secondary)' }}>{form.enabled ? 'Open the full editor to customize the public page using documented classes and CSS variables.' : 'Enable custom branding to edit and apply custom CSS.'}</p>
            <button type="button" disabled={!form.enabled} onClick={() => setCssEditorOpen(true)} className="btn btn-primary btn-sm w-full py-2.5"><span aria-hidden="true" className="material-symbols-outlined">code</span>Open CSS editor</button>
            <p className="text-[10px]" style={{ color: 'var(--m3-secondary)' }}>{form.customCss ? `${form.customCss.split('\n').length} lines · ${form.customCss.length} characters` : 'No custom CSS yet'}</p>
          </Section>
          </fieldset>
        </div>

        <div className="px-5 py-4 shrink-0 flex items-center gap-3" style={{ borderTop: '1px solid var(--m3-outline-variant)' }}>
          <button type="button" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || thresholdError !== null} className="btn btn-primary flex-1">{saveMutation.isPending ? 'Saving…' : 'Save branding'}</button>
          {saved && <span className="flex items-center gap-1 text-sm shrink-0" style={{ color: 'var(--m3-up)' }}><span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: 16 }}>check_circle</span>Saved!</span>}
          {saveMutation.isError && <span role="alert" className="text-xs" style={{ color: 'var(--m3-down)' }}>{saveMutation.error instanceof Error ? saveMutation.error.message : 'Save failed'}</span>}
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-2 shrink-0 flex items-center gap-2" style={{ background: 'var(--m3-surface-container-low)', borderBottom: '1px solid var(--m3-outline-variant)' }}>
          <span aria-hidden="true" className="w-2 h-2 rounded-full" style={{ background: 'var(--m3-primary)', animation: 'orbGlow 2s ease-in-out infinite' }} />
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
    {url && <div className="flex items-center gap-2 mb-2"><div className="h-12 min-w-24 max-w-48 flex items-center rounded-lg px-3" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}><img src={url} alt="Logo" className="max-h-9 max-w-full object-contain" /></div><button type="button" onClick={onRemove} className="btn-icon text-base" aria-label={`Remove ${label.toLowerCase()}`} title="Remove logo">×</button></div>}
    <input id={id} type="file" accept="image/jpeg,image/png,image/gif,image/webp" onChange={(event) => onSelect(event.target.files?.[0] ?? null)} className="sr-only" />
    <div className="flex items-center gap-2 min-w-0"><label htmlFor={id} className="btn btn-primary btn-sm shrink-0 cursor-pointer">Choose image</label><span className="text-xs truncate" style={{ color: 'var(--m3-secondary)' }} title={file?.name}>{file?.name ?? 'No file selected'}</span></div>
  </div>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="space-y-3"><p className="font-mono text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--m3-secondary)' }}>{title}</p><div className="space-y-2">{children}</div></div>
}


/** One colour of the uptime bar; without `onChange` the value is derived and shown read-only. */
function ThresholdRow({ color, label, operator, value, onChange, first = false }: {
  color: string
  label: string
  operator: string
  value: string
  onChange?: (value: string) => void
  first?: boolean
}) {
  return <div className="grid items-center gap-2 px-3 py-2" style={{ gridTemplateColumns: '12px 1fr 14px 76px', background: 'var(--m3-surface-container-lowest)', borderTop: first ? undefined : '1px solid var(--m3-outline-variant)' }}>
    <span aria-hidden="true" className="w-3 h-3 rounded" style={{ background: color }} />
    <span className="text-xs">{label}</span>
    <span aria-hidden="true" className="font-mono text-xs text-right" style={{ color: 'var(--m3-secondary)' }}>{operator}</span>
    {onChange
      ? <input type="number" min={0} max={100} step={0.01} value={value} onChange={(event) => onChange(event.target.value)} aria-label={`${label} from (%)`} className="input-sig font-mono text-xs" />
      : <span className="font-mono text-xs px-2 py-1.5 rounded-md" style={{ color: 'var(--m3-secondary)', border: '1px dashed var(--m3-outline-variant)' }} aria-label={`${label} below (%)`}>{value || '…'} <span className="text-[10px]">auto</span></span>}
  </div>
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <Field label={label} variant="plain">{(control) => <div className="flex items-center gap-2"><input type="color" aria-label={`${label} picker`} value={value.startsWith('rgba') ? '#000000' : value} onChange={(event) => onChange(event.target.value)} className="w-8 h-8 rounded-md cursor-pointer shrink-0 p-0.5" style={{ border: '1px solid var(--m3-outline-variant)', background: 'var(--m3-surface-container-lowest)' }} /><input {...control} value={value} onChange={(event) => onChange(event.target.value)} maxLength={25} className="input-sig font-mono text-xs" /></div>}</Field>
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
  ['.bsp-project-link', 'BetterStatusPage link'],
] as const

const CSS_VARIABLES = [
  '--bsp-bg', '--bsp-card-bg', '--bsp-elevated-bg', '--bsp-card-border',
  '--bsp-text', '--bsp-text-muted', '--bsp-primary', '--bsp-accent',
  '--bsp-up', '--bsp-down', '--bsp-degraded', '--bsp-partial', '--bsp-chart-bg', '--bsp-chart-grid',
] as const

function CssEditorModal({ value, onChange, onClose }: { value: string; onChange: (value: string) => void; onClose: () => void }) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  const gutter = useRef<HTMLDivElement>(null)
  const lineCount = Math.max(1, value.split('\n').length)

  // Escape, focus trapping and the backdrop come from ModalShell; start typing straight away.
  useEffect(() => { textarea.current?.focus() }, [])

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
    <ModalShell onClose={onClose} label="Custom CSS editor">
      <div className="w-full min-w-0 min-h-[calc(100vh-32px)] md:m-4 md:min-h-[calc(100vh-64px)] rounded-2xl overflow-hidden flex flex-col" style={{ background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)', boxShadow: '0 24px 80px rgba(0,0,0,0.35)' }}>
        <header className="px-5 py-4 flex items-center gap-4" style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
          <span aria-hidden="true" className="material-symbols-outlined rounded-xl p-2" style={{ background: 'var(--admin-icon-container)', color: 'var(--admin-icon-color)' }}>code</span>
          <div><h2 className="font-headline text-lg font-semibold">Custom CSS editor</h2><p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>Changes are applied to the live preview immediately. Save branding when you are finished.</p></div>
          <button type="button" onClick={onClose} className="btn btn-primary ml-auto px-5">Done</button>
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
    </ModalShell>
  )
}
