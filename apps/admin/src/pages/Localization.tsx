import { useCallback, useEffect, useId, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { EN_DEFAULTS, builtInDefaultsFor, type Locale, type TranslationKey } from '@bsp/shared'
import { ConfirmModal } from '../components/ConfirmModal'
import { Alert, ErrorState, LoadingState, PageContainer, PageHeader, useToast } from '../components/ui'

/* ── Translation key groups ──────────────────────────────────────── */
const ALL_KEYS = Object.keys(EN_DEFAULTS) as TranslationKey[]

function keysWithPrefix(...prefixes: string[]): TranslationKey[] {
  return ALL_KEYS.filter((key) => prefixes.some((prefix) => key.startsWith(prefix)))
}

const NAMED_GROUPS: Array<{ label: string; keys: TranslationKey[] }> = [
  { label: 'Status Labels', keys: keysWithPrefix('status.') },
  { label: 'Overall Page Status', keys: keysWithPrefix('overall.') },
  { label: 'Page Copy', keys: keysWithPrefix('page.', 'section.', 'tab.') },
  { label: 'Empty States', keys: keysWithPrefix('empty.') },
  { label: 'Uptime Bars & Tooltips', keys: keysWithPrefix('uptime.') },
  { label: 'Incidents', keys: keysWithPrefix('incident.') },
  { label: 'Response Time Chart', keys: keysWithPrefix('chart.') },
  { label: 'Subscriptions', keys: keysWithPrefix('subscribe.') },
]

const GROUPED_KEYS = new Set(NAMED_GROUPS.flatMap((group) => group.keys))
const UNGROUPED_KEYS = ALL_KEYS.filter((key) => !GROUPED_KEYS.has(key))

/** Every translation key is editable: keys added later without a named group land in "Other". */
const STATUS_PAGE_GROUPS: Array<{ label: string; keys: TranslationKey[] }> = UNGROUPED_KEYS.length > 0
  ? [...NAMED_GROUPS, { label: 'Other', keys: UNGROUPED_KEYS }]
  : NAMED_GROUPS

type Translations = Partial<Record<TranslationKey, string>>

/** Empty values fall back to the defaults, so they are equivalent to a missing key when comparing edits. */
function sameTranslations(a: Translations, b: Translations) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as TranslationKey[])
  for (const key of keys) {
    if ((a[key] ?? '') !== (b[key] ?? '')) return false
  }
  return true
}

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback
}

/* ── Key row editor ──────────────────────────────────────────────── */
function KeyRow({ keyName, placeholder, value, onChange }: {
  keyName: string
  placeholder: string
  value: string
  onChange: (v: string) => void
}) {
  const inputId = useId()
  return (
    <div
      className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4 py-3"
      style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}
    >
      <label
        htmlFor={inputId}
        className="font-mono text-xs sm:w-64 flex-shrink-0 break-all"
        style={{ color: 'var(--m3-secondary)' }}
      >
        {keyName}
      </label>
      <input
        id={inputId}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 min-w-0 bg-transparent text-sm py-1 outline-none border-b transition-colors border-[color:var(--m3-outline-variant)] focus:border-[color:var(--m3-primary)] placeholder:text-[color:var(--m3-outline)]"
        style={{ color: 'var(--m3-on-surface)' }}
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
  const toast = useToast()
  const codeId = useId()
  const nameId = useId()

  const createMutation = useMutation({
    mutationFn: () => api.post('/admin/locales', { code: code.trim().toLowerCase(), name: name.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-locales'] })
      toast.success(`Added ${name.trim()}.`)
      setCode(''); setName(''); setError('')
      onCreated()
    },
    onError: (e: Error) => setError(e.message || 'Failed to create locale'),
  })

  const canCreate = Boolean(code.trim() && name.trim()) && !createMutation.isPending

  return (
    <div
      className="p-4 rounded-xl space-y-3 mt-2"
      style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}
    >
      <p className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--m3-secondary)' }}>
        New Language
      </p>
      <div>
        <label htmlFor={codeId} className="block text-xs mb-1.5" style={{ color: 'var(--m3-secondary)' }}>Code</label>
        <input
          id={codeId}
          type="text"
          placeholder="Code (e.g. pl, de, fr)"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="input-m3"
        />
      </div>
      <div>
        <label htmlFor={nameId} className="block text-xs mb-1.5" style={{ color: 'var(--m3-secondary)' }}>Name</label>
        <input
          id={nameId}
          type="text"
          placeholder="Name (e.g. Polski, Deutsch)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="input-m3"
          onKeyDown={(e) => e.key === 'Enter' && canCreate && createMutation.mutate()}
        />
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <button
        type="button"
        onClick={() => createMutation.mutate()}
        disabled={!canCreate}
        className="btn btn-primary w-full"
      >
        {createMutation.isPending ? 'Creating…' : 'Create Language'}
      </button>
    </div>
  )
}

/* ── Locale editor panel ─────────────────────────────────────────── */
function LocaleEditor({ locale, onDelete, onDirtyChange }: {
  locale: Locale
  onDelete: () => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const [translations, setTranslations] = useState<Translations>(() => locale.translations ?? {})
  const [baseline, setBaseline] = useState<Translations>(() => locale.translations ?? {})
  const [saved, setSaved] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const qc = useQueryClient()
  const toast = useToast()
  const builtIn = builtInDefaultsFor(locale.code)
  const placeholders = builtIn?.translations ?? EN_DEFAULTS
  const dirty = !sameTranslations(translations, baseline)

  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])

  const saveMutation = useMutation({
    mutationFn: (next: Translations) => api.patch(`/admin/locales/${locale.code}`, { translations: next }),
    onSuccess: (_data, next) => {
      qc.invalidateQueries({ queryKey: ['admin-locales'] })
      setBaseline(next)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
    onError: (err) => toast.error(errorMessage(err, 'Failed to save translations')),
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/admin/locales/${locale.code}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-locales'] })
      toast.success(`Deleted ${locale.name}.`)
      setConfirmDelete(false)
      onDelete()
    },
    onError: (err) => {
      setConfirmDelete(false)
      toast.error(errorMessage(err, 'Failed to delete language'))
    },
  })

  const setDefaultMutation = useMutation({
    mutationFn: () => api.post(`/admin/locales/${locale.code}/set-default`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-locales'] })
      toast.success(`${locale.name} is now the default language.`)
    },
    onError: (err) => toast.error(errorMessage(err, 'Failed to set the default language')),
  })

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h2 className="font-headline text-2xl font-bold" style={{ color: 'var(--m3-on-surface)' }}>
            {locale.name}
          </h2>
          <span
            className="font-mono text-xs px-2 py-0.5 rounded"
            style={{ background: 'var(--m3-surface-container)', color: 'var(--m3-secondary)' }}
          >
            {locale.code}
          </span>
          {locale.isDefault === 1 && (
            <span
              className="selection-active ml-2 text-xs font-bold px-2 py-0.5 rounded-full border"
              style={{ background: 'var(--m3-primary-container)', color: 'var(--m3-on-primary-container)' }}
            >
              Default
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {locale.isDefault === 0 && (
            <button
              type="button"
              onClick={() => setDefaultMutation.mutate()}
              disabled={setDefaultMutation.isPending}
              className="btn btn-secondary"
            >
              {setDefaultMutation.isPending ? 'Setting…' : 'Set as Default'}
            </button>
          )}
          {locale.isDefault === 0 && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={deleteMutation.isPending}
              className="btn btn-danger-outline"
            >
              Delete
            </button>
          )}
          <button
            type="button"
            onClick={() => saveMutation.mutate(translations)}
            disabled={saveMutation.isPending}
            className="btn btn-primary"
          >
            {saved ? 'Saved!' : saveMutation.isPending ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>

      <Alert tone="info" className="mb-4">
        {builtIn?.language === 'English'
          ? 'English is the built-in default. Values left empty will automatically use the English defaults.'
          : builtIn
            ? `${builtIn.language} has built-in defaults. Values left empty will automatically use the ${builtIn.language} defaults.`
            : 'This language has no built-in defaults. Values left empty will automatically use the English defaults.'}
      </Alert>

      {/* Keys */}
      <div className="flex-1 overflow-y-auto lg:pr-2">
        {STATUS_PAGE_GROUPS.map((group) => (
          <section key={group.label} className="mb-8" aria-label={group.label}>
            <h3
              className="text-xs font-bold uppercase tracking-widest mb-3"
              style={{ color: 'var(--m3-secondary)' }}
            >
              {group.label}
            </h3>
            {group.keys.map((key) => (
              <KeyRow
                key={key}
                keyName={key}
                placeholder={placeholders[key] ?? EN_DEFAULTS[key]}
                value={translations[key] ?? ''}
                onChange={(v) => setTranslations((prev) => ({ ...prev, [key]: v }))}
              />
            ))}
          </section>
        ))}
      </div>

      {confirmDelete && (
        <ConfirmModal
          title="Delete language"
          message={`Delete ${locale.name} (${locale.code})? Its translations will be removed and visitors using it will see the default language.`}
          confirmLabel="Delete language"
          pending={deleteMutation.isPending}
          pendingLabel="Deleting…"
          onConfirm={() => deleteMutation.mutate()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}

/* ── Main Page ───────────────────────────────────────────────────── */
export default function LocalizationPage() {
  const { data: locales = [], isLoading, isError, refetch } = useQuery<Locale[]>({
    queryKey: ['admin-locales'],
    queryFn: () => api.get('/admin/locales'),
  })

  const [selected, setSelected] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null)
  const handleDirtyChange = useCallback((value: boolean) => setDirty(value), [])

  const selectedLocale = locales.find((l) => l.code === selected) ?? locales[0]

  function selectLocale(code: string) {
    setShowAdd(false)
    if (code === selectedLocale?.code) return
    if (dirty) { setPendingSwitch(code); return }
    setSelected(code)
  }

  return (
    <PageContainer className="max-w-[1440px] mx-auto">
      <PageHeader title="Localization" subtitle="Manage languages and translations for your status page." />

      {isLoading ? (
        <LoadingState label="Loading languages…" />
      ) : isError ? (
        <ErrorState message="Could not load languages." onRetry={() => void refetch()} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6 lg:gap-8 items-start">
          {/* Left: locale list */}
          <nav
            aria-label="Languages"
            className="rounded-2xl p-4 space-y-1 lg:sticky lg:top-8"
            style={{ background: 'var(--m3-surface-container-lowest)' }}
          >
            {locales.map((locale) => {
              const active = locale.code === selectedLocale?.code
              return (
                <button
                  key={locale.code}
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => selectLocale(locale.code)}
                  className="w-full flex items-center justify-between px-4 py-3 rounded-xl text-sm transition-all focus-ring hover:bg-[var(--m3-surface-container)]"
                  style={{
                    background: active ? 'var(--m3-surface-container)' : undefined,
                    color: 'var(--m3-on-surface)',
                    fontWeight: active ? 700 : 400,
                  }}
                >
                  <span>{locale.name}</span>
                  <div className="flex items-center gap-2">
                    {locale.isDefault === 1 && (
                      <>
                        <span className="w-1.5 h-1.5 rounded-full" aria-hidden="true" style={{ background: 'var(--m3-on-primary-container)' }} />
                        <span className="sr-only">(default)</span>
                      </>
                    )}
                    <span className="font-mono text-xs" style={{ color: 'var(--m3-secondary)' }}>
                      {locale.code}
                    </span>
                  </div>
                </button>
              )
            })}

            <div style={{ borderTop: '1px solid var(--m3-outline-variant)', marginTop: '8px', paddingTop: '8px' }}>
              <button
                type="button"
                onClick={() => setShowAdd((v) => !v)}
                aria-expanded={showAdd}
                className="btn btn-ghost w-full justify-start"
              >
                <span className="material-symbols-outlined" aria-hidden="true">add</span>
                Add Language
              </button>
              {showAdd && (
                <AddLocaleForm onCreated={() => setShowAdd(false)} />
              )}
            </div>
          </nav>

          {/* Right: editor */}
          <div
            className="rounded-2xl p-4 md:p-8 min-w-0 lg:min-h-[600px]"
            style={{ background: 'var(--m3-surface-container-lowest)' }}
          >
            {selectedLocale ? (
              <LocaleEditor
                key={selectedLocale.code}
                locale={selectedLocale}
                onDirtyChange={handleDirtyChange}
                onDelete={() => { setDirty(false); setSelected(null) }}
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

      {pendingSwitch && (
        <ConfirmModal
          title="Discard unsaved changes?"
          message={`You have unsaved translation changes for ${selectedLocale?.name ?? 'this language'}. Switching languages will discard them.`}
          confirmLabel="Discard changes"
          onConfirm={() => { setDirty(false); setSelected(pendingSwitch); setPendingSwitch(null) }}
          onCancel={() => setPendingSwitch(null)}
        />
      )}
    </PageContainer>
  )
}
