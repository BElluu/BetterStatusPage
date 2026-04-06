import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Locale, TranslationKey } from '@bsp/shared'
import { EN_DEFAULTS } from '../i18n/statusDefaults'

/* ── Translation key groups ──────────────────────────────────────── */
const STATUS_PAGE_GROUPS: Array<{ label: string; keys: TranslationKey[] }> = [
  {
    label: 'Status Labels',
    keys: ['status.operational','status.outage','status.partialOutage','status.degraded','status.checking','status.pending'],
  },
  {
    label: 'Overall Page Status',
    keys: ['overall.allOperational','overall.majorOutage','overall.partialOutage','overall.partialDegradation','overall.incidentsInProgress','overall.checking'],
  },
  {
    label: 'Page Copy',
    keys: ['page.hero','page.monitoredLine','page.incidentLine','page.groupServiceCount'],
  },
  {
    label: 'Uptime Bars & Tooltips',
    keys: ['uptime.daysAgo','uptime.today','uptime.noData','uptime.pct','uptime.resolvedIn','uptime.ongoing','uptime.affected','uptime.noIncidents'],
  },
  {
    label: 'Incident Statuses',
    keys: ['incident.investigating','incident.identified','incident.monitoring','incident.resolved'],
  },
]

/* ── Key row editor ──────────────────────────────────────────────── */
function KeyRow({ keyName, placeholder, value, onChange }: {
  keyName: string
  placeholder: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div
      className="flex items-center gap-4 py-3"
      style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}
    >
      <span
        className="font-mono text-xs w-64 flex-shrink-0"
        style={{ color: 'var(--m3-secondary)' }}
      >
        {keyName}
      </span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 bg-transparent text-sm outline-none border-b border-transparent transition-colors"
        style={{ color: 'var(--m3-on-surface)' }}
        onFocus={(e) => { (e.target).style.borderBottomColor = 'var(--m3-primary)' }}
        onBlur={(e) => { (e.target).style.borderBottomColor = 'transparent' }}
      />
    </div>
  )
}

/* ── Add locale form ─────────────────────────────────────────────── */
function AddLocaleForm({ onCreated }: { onCreated: () => void }) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const qc = useQueryClient()

  const createMutation = useMutation({
    mutationFn: () => api.post('/admin/locales', { code: code.trim().toLowerCase(), name: name.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-locales'] })
      setCode(''); setName(''); setError('')
      onCreated()
    },
    onError: (e: Error) => setError(e.message || 'Failed to create locale'),
  })

  return (
    <div
      className="p-4 rounded-xl space-y-3 mt-2"
      style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}
    >
      <p className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--m3-secondary)' }}>
        New Language
      </p>
      <input
        type="text"
        placeholder="Code (e.g. pl, de, fr)"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        className="w-full bg-transparent text-sm outline-none border-b py-1"
        style={{ color: 'var(--m3-on-surface)', borderBottomColor: 'var(--m3-outline-variant)' }}
      />
      <input
        type="text"
        placeholder="Name (e.g. Polski, Deutsch)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full bg-transparent text-sm outline-none border-b py-1"
        style={{ color: 'var(--m3-on-surface)', borderBottomColor: 'var(--m3-outline-variant)' }}
        onKeyDown={(e) => e.key === 'Enter' && createMutation.mutate()}
      />
      {error && <p className="text-xs" style={{ color: 'var(--m3-error)' }}>{error}</p>}
      <button
        onClick={() => createMutation.mutate()}
        disabled={!code.trim() || !name.trim() || createMutation.isPending}
        className="w-full py-2 rounded-lg text-sm font-bold transition-colors"
        style={{
          background: 'var(--m3-primary)',
          color: 'var(--m3-on-primary)',
          opacity: (!code.trim() || !name.trim()) ? 0.5 : 1,
        }}
      >
        {createMutation.isPending ? 'Creating…' : 'Create Language'}
      </button>
    </div>
  )
}

/* ── Locale editor panel ─────────────────────────────────────────── */
function LocaleEditor({ locale, onDelete }: { locale: Locale; onDelete: () => void }) {
  const [translations, setTranslations] = useState<Partial<Record<TranslationKey, string>>>(() => locale.translations ?? {})
  const [saved, setSaved] = useState(false)
  const qc = useQueryClient()

  const saveMutation = useMutation({
    mutationFn: () => api.patch(`/admin/locales/${locale.code}`, { translations }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-locales'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/admin/locales/${locale.code}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-locales'] })
      onDelete()
    },
  })

  const setDefaultMutation = useMutation({
    mutationFn: () => api.post(`/admin/locales/${locale.code}/set-default`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-locales'] }),
  })

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="font-headline text-2xl font-bold" style={{ color: 'var(--m3-on-surface)' }}>
            {locale.name}
          </h3>
          <span
            className="font-mono text-xs px-2 py-0.5 rounded"
            style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)' }}
          >
            {locale.code}
          </span>
          {locale.isDefault === 1 && (
            <span
              className="ml-2 text-xs font-bold px-2 py-0.5 rounded-full"
              style={{ background: 'var(--m3-primary-container)', color: 'var(--m3-on-primary-container)' }}
            >
              Default
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {locale.isDefault === 0 && (
            <button
              onClick={() => setDefaultMutation.mutate()}
              disabled={setDefaultMutation.isPending}
              className="px-4 py-2 rounded-full text-sm font-bold transition-colors"
              style={{ background: 'var(--m3-secondary-container)', color: 'var(--m3-on-secondary-container)' }}
            >
              {setDefaultMutation.isPending ? 'Setting…' : 'Set as Default'}
            </button>
          )}
          {locale.isDefault === 0 && (
            <button
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="px-4 py-2 rounded-full text-sm font-bold transition-colors"
              style={{ background: 'var(--m3-error-container)', color: 'var(--m3-on-error-container)' }}
            >
              Delete
            </button>
          )}
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="px-5 py-2 rounded-full text-sm font-bold transition-colors"
            style={{ background: 'var(--m3-primary)', color: 'var(--m3-on-primary)' }}
          >
            {saved ? 'Saved!' : saveMutation.isPending ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>

      {locale.isDefault === 1 && (
        <div
          className="mb-4 px-4 py-3 rounded-xl text-sm"
          style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-on-surface-variant)' }}
        >
          English is the built-in default. Values left empty will automatically use the English defaults.
        </div>
      )}

      {/* Keys */}
      <div className="flex-1 overflow-y-auto pr-2">
        {STATUS_PAGE_GROUPS.map((group) => (
          <div key={group.label} className="mb-8">
            <p
              className="text-xs font-bold uppercase tracking-widest mb-3"
              style={{ color: 'var(--m3-secondary)' }}
            >
              {group.label}
            </p>
            {group.keys.map((key) => (
              <KeyRow
                key={key}
                keyName={key}
                placeholder={EN_DEFAULTS[key]}
                value={translations[key] ?? ''}
                onChange={(v) => setTranslations((prev) => ({ ...prev, [key]: v }))}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Main Page ───────────────────────────────────────────────────── */
export default function LocalizationPage() {
  const { data: locales = [], isLoading } = useQuery<Locale[]>({
    queryKey: ['admin-locales'],
    queryFn: () => api.get('/admin/locales'),
  })

  const [selected, setSelected] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const selectedLocale = locales.find((l) => l.code === selected) ?? locales[0]

  return (
    <div className="px-8 max-w-[1440px] mx-auto pb-24 fade-up">
      <header className="flex justify-between items-center pt-12 mb-12">
        <div>
          <h2 className="font-headline text-4xl font-extrabold tracking-tighter mb-2" style={{ color: 'var(--m3-on-surface)' }}>
            Localization
          </h2>
          <p className="font-sans text-lg" style={{ color: 'var(--m3-secondary)' }}>
            Manage languages and translations for your status page.
          </p>
        </div>
      </header>

      {isLoading ? (
        <div className="flex items-center justify-center py-24">
          <span className="text-sm" style={{ color: 'var(--m3-secondary)' }}>Loading…</span>
        </div>
      ) : (
        <div className="grid grid-cols-[280px_1fr] gap-8 items-start">
          {/* Left: locale list */}
          <div
            className="rounded-2xl p-4 space-y-1 sticky top-8"
            style={{ background: 'var(--m3-surface-container-lowest)' }}
          >
            {locales.map((locale) => (
              <button
                key={locale.code}
                onClick={() => { setSelected(locale.code); setShowAdd(false) }}
                className="w-full flex items-center justify-between px-4 py-3 rounded-xl text-sm transition-all"
                style={{
                  background: (selected === locale.code || (!selected && locale === locales[0]))
                    ? 'var(--m3-surface-container)'
                    : 'transparent',
                  color: 'var(--m3-on-surface)',
                  fontWeight: (selected === locale.code || (!selected && locale === locales[0])) ? 700 : 400,
                }}
              >
                <span>{locale.name}</span>
                <div className="flex items-center gap-2">
                  {locale.isDefault === 1 && (
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--m3-primary)' }} />
                  )}
                  <span className="font-mono text-xs" style={{ color: 'var(--m3-secondary)' }}>
                    {locale.code}
                  </span>
                </div>
              </button>
            ))}

            <div style={{ borderTop: '1px solid var(--m3-outline-variant)', marginTop: '8px', paddingTop: '8px' }}>
              <button
                onClick={() => setShowAdd((v) => !v)}
                className="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-all"
                style={{ color: 'var(--m3-secondary)' }}
                onMouseEnter={(e) => { (e.currentTarget).style.background = 'rgba(0,0,0,0.04)'; (e.currentTarget).style.color = 'var(--m3-on-surface)' }}
                onMouseLeave={(e) => { (e.currentTarget).style.background = ''; (e.currentTarget).style.color = 'var(--m3-secondary)' }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>add</span>
                Add Language
              </button>
              {showAdd && (
                <AddLocaleForm onCreated={() => setShowAdd(false)} />
              )}
            </div>
          </div>

          {/* Right: editor */}
          <div
            className="rounded-2xl p-8"
            style={{
              background: 'var(--m3-surface-container-lowest)',
              minHeight: '600px',
            }}
          >
            {selectedLocale ? (
              <LocaleEditor
                key={selectedLocale.code}
                locale={selectedLocale}
                onDelete={() => setSelected(null)}
              />
            ) : (
              <div className="flex items-center justify-center h-64">
                <p className="text-sm" style={{ color: 'var(--m3-secondary)' }}>
                  Select a language to edit translations.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
