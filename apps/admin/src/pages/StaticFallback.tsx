import { useEffect, useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AdminStaticMirror, StaticMirrorCheckResult, StaticMirrorHealthState, StaticMirrorSettings } from '@bsp/shared'
import { api } from '../api/client'
import { Alert, ErrorState, LoadingState, PageContainer, PageHeader, Switch, formatDateTime, useToast } from '@better-kit/ui'

const QUERY_KEY = ['static-mirror']
const DOCS_URL = 'https://docs.betterstatuspage.dev/static-fallback/'
const CARD = { background: 'var(--m3-surface-container-lowest)', border: '1px solid var(--m3-outline-variant)', color: 'var(--m3-on-surface)' }
const LABEL = 'block font-mono text-xs uppercase tracking-wider mb-2'
const MUTED = { color: 'var(--m3-secondary)' }

type ProviderId = 'aws' | 'r2' | 'b2' | 'other'

/** Where each kind of storage keeps what the form asks for. The choice only fills in and explains; the server never sees it. */
const PROVIDERS: Array<{ id: ProviderId; label: string; region: string; hint: string }> = [
  { id: 'aws', label: 'AWS S3', region: '', hint: 'Leave Endpoint empty and give the region of the bucket, such as eu-central-1. Create an IAM user whose policy allows s3:PutObject on the bucket (and s3:DeleteObject, so Check access can clean up after itself).' },
  { id: 'r2', label: 'Cloudflare R2', region: 'auto', hint: 'In Cloudflare, open R2 → your bucket → Settings and copy the S3 API address into Endpoint. Create the key under R2 → Manage API tokens with Object Read & Write. Region stays auto.' },
  { id: 'b2', label: 'Backblaze B2', region: 'us-west-004', hint: 'In Backblaze, open Buckets and copy the Endpoint of the bucket (https://s3.REGION.backblazeb2.com); the region is the part after s3. Create an application key limited to this bucket.' },
  { id: 'other', label: 'MinIO / other', region: 'us-east-1', hint: 'Use the S3 API address of the service as Endpoint. Most services accept us-east-1 as the region.' },
]

const INTERVALS = [{ seconds: 60, label: '1 min' }, { seconds: 300, label: '5 min' }, { seconds: 900, label: '15 min' }]

function detectProvider(endpoint: string, region: string): ProviderId {
  // A new setup starts with the region "auto"; a saved one without an endpoint is AWS.
  if (!endpoint) return region === 'auto' ? 'r2' : 'aws'
  if (endpoint.includes('r2.cloudflarestorage.com')) return 'r2'
  if (endpoint.includes('backblazeb2.com')) return 'b2'
  return 'other'
}

const HEALTH: Record<StaticMirrorHealthState, { label: string; style: React.CSSProperties; dot: string }> = {
  ok: { label: 'Up to date', style: { background: 'var(--m3-up-bg)', color: 'var(--m3-up)' }, dot: 'var(--m3-up)' },
  stale: { label: 'Stale', style: { background: 'var(--m3-degraded-bg)', color: 'var(--m3-degraded)' }, dot: 'var(--m3-degraded)' },
  error: { label: 'Failing', style: { background: 'var(--m3-error-container)', color: 'var(--m3-on-error-container)' }, dot: 'var(--m3-down)' },
  pending: { label: 'Waiting', style: { background: 'var(--m3-surface-container-high)', color: 'var(--m3-secondary)' }, dot: 'var(--m3-secondary)' },
  disabled: { label: 'Off', style: { background: 'var(--m3-surface-container-high)', color: 'var(--m3-secondary)' }, dot: 'var(--m3-secondary)' },
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} minutes`
  return `${Math.round(minutes / 60)} hours`
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const formatDate = (value: number | null) => (value === null ? 'Never' : formatDateTime(value))
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function Card({ children, className = '', ...rest }: React.HTMLAttributes<HTMLElement>) {
  return <section className={`rounded-2xl p-5 md:p-6 ${className}`} style={CARD} {...rest}>{children}</section>
}

function Field({ id, label, hint, className, children }: { id: string; label: string; hint?: string | undefined; className?: string; children: React.ReactNode }) {
  return (
    <div className={className}>
      <label htmlFor={id} className={LABEL} style={MUTED}>{label}</label>
      {children}
      {hint && <p id={`${id}-hint`} className="text-xs mt-1.5" style={MUTED}>{hint}</p>}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><dt className="text-xs uppercase tracking-wide" style={MUTED}>{label}</dt><dd className="mt-1 font-medium">{value}</dd></div>
}

function Segmented<T extends string | number>({ label, value, options, onChange }: {
  label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void
}) {
  const id = useId()
  return (
    <div>
      <div id={id} className={LABEL} style={MUTED}>{label}</div>
      <div role="group" aria-labelledby={id} className="inline-flex flex-wrap gap-0.5 rounded-xl p-[3px]" style={{ background: 'var(--m3-surface-container)' }}>
        {options.map((option) => {
          const pressed = option.value === value
          return (
            <button
              key={String(option.value)}
              type="button"
              aria-pressed={pressed}
              onClick={() => onChange(option.value)}
              className="rounded-[9px] px-3.5 py-1.5 text-[13px] font-semibold"
              style={pressed ? { background: 'var(--m3-surface-container-lowest)', color: 'var(--m3-on-surface)', boxShadow: '0 1px 2px rgba(28,35,51,.18)' } : { color: 'var(--m3-secondary)' }}
            >{option.label}</button>
          )
        })}
      </div>
    </div>
  )
}

/** A sample of the bar on the copy, as visitors see it. */
function BannerSample({ stale }: { stale: boolean }) {
  return (
    <div
      className="px-3 py-2 text-xs font-semibold text-center"
      style={stale ? { background: 'var(--m3-degraded)', color: 'var(--m3-surface)' } : { background: 'var(--admin-icon-container)', color: 'var(--m3-on-surface)' }}
    >
      {stale ? 'Last saved state from 19 Oct 2026, 20:12. It may be out of date.' : 'Saved copy of the status page, taken 19 Oct 2026, 20:29. The live page may be unavailable.'}
    </div>
  )
}

/** Where the saved copy of the public page is pushed, and how the last pushes went. */
export default function StaticFallbackPage() {
  const { data, isError, refetch } = useQuery<AdminStaticMirror>({
    queryKey: QUERY_KEY,
    queryFn: () => api.get('/admin/static-mirror'),
    refetchInterval: 15_000,
  })
  const header = <PageHeader title="Static fallback" subtitle="A saved copy of your status page on storage that does not depend on this server, for the day this server is down." />

  if (!data) {
    return <PageContainer>{header}{isError
      ? <ErrorState message="Could not load the static fallback settings." onRetry={() => void refetch()} />
      : <LoadingState label="Loading static fallback…" />}</PageContainer>
  }
  return <PageContainer className="text-[color:var(--m3-on-surface)]">{header}<Fallback data={data} /></PageContainer>
}

function Fallback({ data }: { data: AdminStaticMirror }) {
  const qc = useQueryClient()
  const toast = useToast()
  const ids = useId()
  const now = useNow(5_000)
  const saved = data.settings
  const [form, setForm] = useState<StaticMirrorSettings>(saved)
  const [provider, setProvider] = useState<ProviderId>(() => detectProvider(saved.endpoint, saved.region))
  const [replacing, setReplacing] = useState(false)
  const [customInterval, setCustomInterval] = useState(() => !INTERVALS.some((i) => i.seconds === saved.intervalSeconds))
  const [error, setError] = useState('')
  const [check, setCheck] = useState<StaticMirrorCheckResult | null>(null)
  const dirty = JSON.stringify(form) !== JSON.stringify(saved)
  const hasSecret = saved.secretAccessKey !== ''
  const secretShown = hasSecret && !replacing && form.secretAccessKey === saved.secretAccessKey

  const set = <K extends keyof StaticMirrorSettings>(key: K, value: StaticMirrorSettings[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
    setCheck(null)
  }
  const choose = (id: ProviderId) => {
    const previous = PROVIDERS.find((p) => p.id === provider)!
    const next = PROVIDERS.find((p) => p.id === id)!
    setProvider(id)
    // Replace the region only where the person has not typed their own.
    if (form.region === previous.region || form.region === '') set('region', next.region)
    if (id === 'aws') set('endpoint', '')
  }

  const save = useMutation({
    mutationFn: (body: StaticMirrorSettings) => api.put<AdminStaticMirror>('/admin/static-mirror', body),
    onSuccess: (result) => {
      qc.setQueryData(QUERY_KEY, result)
      setForm(result.settings)
      setReplacing(false)
      setCheck(null)
      setError('')
      // Saving while the mirror is on restarts its schedule, which pushes at once, so a changed setting reaches the copy.
      toast.success(!result.settings.enabled ? 'Static fallback saved.'
        : saved.enabled ? 'Static fallback saved. Pushing the change to the copy now.'
        : 'Static fallback is on. The first push is running.')
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save the settings'),
  })
  const push = useMutation({
    mutationFn: () => api.post<AdminStaticMirror>('/admin/static-mirror/test'),
    onSuccess: (result) => {
      qc.setQueryData(QUERY_KEY, result)
      if (result.status.lastError) setError(result.status.lastError)
      else { setError(''); toast.success('Pushed the status page to the target.') }
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The push failed'),
  })
  const checkAccess = useMutation({
    mutationFn: () => api.post<StaticMirrorCheckResult>('/admin/static-mirror/check', form),
    onSuccess: setCheck,
    onError: (err) => setCheck({ ok: false, error: err instanceof Error ? err.message : 'The check failed' }),
  })

  const { status, runs } = data
  const configured = saved.bucket !== ''
  const health = HEALTH[data.health]
  const busy = save.isPending || push.isPending || checkAccess.isPending
  const pushBlocked = !saved.enabled ? 'Turn the mirror on and save first' : dirty ? 'Save the changes first' : undefined
  const canCheck = form.bucket.trim() !== '' && form.accessKeyId.trim() !== '' && form.secretAccessKey !== ''
  const failedInARow = runs.length - 1 - runs.map((r) => r.ok).lastIndexOf(true)
  const lastSuccessAgo = status.lastSuccessAt === null ? null : ago(now - status.lastSuccessAt)
  const nextPush = saved.enabled && status.lastRunAt !== null ? Math.max(0, status.lastRunAt + saved.intervalSeconds * 1000 - now) : null

  const title = !saved.enabled ? (configured ? 'Static fallback is off' : 'Not set up yet')
    : data.health === 'ok' ? 'The copy is up to date'
    : data.health === 'stale' ? 'The copy is out of date'
    : data.health === 'error' ? 'The copy is going out of date'
    : 'Waiting for the first push'
  const summary = !saved.enabled ? (configured && lastSuccessAgo ? `Nothing is pushed while it is off. The copy on the storage was last refreshed ${lastSuccessAgo} ago.` : null)
    : data.health === 'ok' ? `Refreshed ${lastSuccessAgo} ago. If this server stops answering, visitors who are sent to the copy still see the last known state.`
    : data.health === 'stale' ? `The last successful push was ${lastSuccessAgo} ago, so the copy may be out of date.`
    : data.health === 'pending' ? 'The first push is running. This page updates by itself.'
    : data.health === 'error' ? `${failedInARow > 1 ? `The last ${failedInARow} pushes failed.` : 'The last push failed.'} ${lastSuccessAgo ? `The copy was last refreshed ${lastSuccessAgo} ago.` : 'Nothing has been pushed yet.'}`
    : null

  return (
    <div className="space-y-6">
      {error && <Alert tone="error" onDismiss={() => setError('')}>{error}</Alert>}

      <Card aria-labelledby={`${ids}-hero`}>
        <div className="flex flex-wrap items-center gap-6">
          <div className="min-w-0 flex-1 basis-[420px]">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id={`${ids}-hero`} className="font-headline text-xl font-semibold">{title}</h2>
              <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide" style={health.style}>
                <span className="h-2 w-2 rounded-full" style={{ background: health.dot }} />{health.label}
              </span>
            </div>
            {summary && <p className="mt-2.5 text-[15px] leading-relaxed" style={MUTED}>{summary}</p>}
            <p className="mt-2 text-sm" style={MUTED}>
              The copy only helps if visitors are sent to it when this server is down.{' '}
              <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="font-semibold underline" style={{ color: 'var(--m3-on-surface)' }}>How to set that up</a>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-5">
            <Switch checked={form.enabled} onChange={(value) => set('enabled', value)} label="Push the status page" />
            <button type="button" className="btn btn-primary" disabled={busy || !!pushBlocked} title={pushBlocked} onClick={() => push.mutate()}>
              <span className="material-symbols-outlined" aria-hidden="true">{data.health === 'error' ? 'refresh' : 'cloud_upload'}</span>
              {push.isPending ? 'Pushing…' : data.health === 'error' ? 'Try again' : 'Push now'}
            </button>
          </div>
        </div>

        {saved.enabled && status.lastError && (
          <div className="mt-5 flex items-start gap-3 rounded-xl p-4" style={{ background: 'var(--m3-error-container)', color: 'var(--m3-on-error-container)' }}>
            <span className="material-symbols-outlined" aria-hidden="true">error</span>
            <div className="min-w-0 text-sm"><p className="font-bold">{status.lastError}</p><p className="mt-1.5 leading-relaxed">Pushes continue every interval; this clears with the next one that succeeds.</p></div>
          </div>
        )}

        {!configured && (
          <ol className="mt-6 grid gap-6 border-t pt-5 sm:grid-cols-3" style={{ borderColor: 'var(--m3-outline-variant)' }}>
            {[
              ['Create a bucket', 'On S3, R2, B2 or MinIO. Readable by anyone, served from the root of its own domain.'],
              ['Create an access key', 'Write access to that bucket is all it needs. The secret is stored encrypted.'],
              ['Check, then turn it on', 'Check access tries the key without pushing anything. Turning it on pushes the first copy.'],
            ].map(([step, text], index) => (
              <li key={step} className="flex items-start gap-3.5">
                <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full text-sm font-bold" style={{ background: 'var(--admin-icon-container)' }}>{index + 1}</span>
                <div><p className="font-semibold">{step}</p><p className="mt-1 text-[13px] leading-relaxed" style={MUTED}>{text}</p></div>
              </li>
            ))}
          </ol>
        )}

        {configured && (
          <dl className="mt-6 grid gap-5 border-t pt-5 sm:grid-cols-2 lg:grid-cols-5" style={{ borderColor: 'var(--m3-outline-variant)' }}>
            <Metric label="Last success" value={formatDate(status.lastSuccessAt)} />
            <Metric label="Last attempt" value={formatDate(status.lastRunAt)} />
            <Metric label="Next push" value={nextPush === null ? '—' : `in about ${Math.max(1, Math.round(nextPush / 1000))} s`} />
            <Metric label="Uploaded last time" value={plural(status.lastUploadedFiles, 'file')} />
            <Metric label="Copy holds" value={status.copyFiles === null || status.copyBytes === null ? '—' : `${plural(status.copyFiles, 'file')} · ${formatBytes(status.copyBytes)}`} />
          </dl>
        )}

        {runs.length > 0 && (
          <div className="mt-6">
            <div className={LABEL} style={MUTED}>Last {runs.length} pushes</div>
            <div
              role="img"
              aria-label={`${runs.filter((r) => r.ok).length} of the last ${runs.length} pushes succeeded`}
              className="flex flex-wrap items-end gap-[5px]"
            >
              {runs.map((run) => (
                <span
                  key={run.at}
                  title={`${formatDateTime(run.at)} · ${run.ok ? plural(run.uploadedFiles, 'file') + ' uploaded' : run.error ?? 'failed'}`}
                  className="h-[30px] w-[11px] rounded"
                  style={{ background: run.ok ? 'var(--m3-up)' : 'var(--m3-down)' }}
                />
              ))}
            </div>
            <p className="mt-2 text-xs" style={MUTED}>Hover a bar for its time and result. Only changed files are uploaded, so a healthy push usually sends one.</p>
          </div>
        )}
      </Card>

      <form
        className="space-y-6"
        onSubmit={(event) => { event.preventDefault(); save.mutate(form) }}
      >
        <div className="flex flex-wrap items-start gap-6">
          <Card aria-labelledby={`${ids}-target`} className="min-w-0 flex-1 basis-[560px]">
            <fieldset disabled={busy} className="space-y-6">
              <legend className="sr-only">Target</legend>
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined rounded-xl p-2.5" aria-hidden="true" style={{ background: 'var(--admin-icon-container)', color: 'var(--admin-icon-color)' }}>database</span>
                <div><h2 id={`${ids}-target`} className="font-headline text-lg font-bold">Where the copy is stored</h2><p className="text-xs" style={MUTED}>S3-compatible storage. The access key only needs to write.</p></div>
              </div>

              <div>
                <Segmented label="Provider" value={provider} options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))} onChange={choose} />
                <p className="mt-3 flex items-start gap-2.5 rounded-xl p-3 text-[13px] leading-relaxed" style={{ background: 'var(--m3-surface-container-low)', ...MUTED }}>
                  <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 18 }}>info</span>
                  <span>{PROVIDERS.find((p) => p.id === provider)!.hint}</span>
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field id={`${ids}-bucket`} label="Bucket"><input id={`${ids}-bucket`} className="input-m3" value={form.bucket} onChange={(e) => set('bucket', e.target.value)} autoComplete="off" placeholder="status-copy" /></Field>
                <Field id={`${ids}-region`} label="Region"><input id={`${ids}-region`} className="input-m3" value={form.region} onChange={(e) => set('region', e.target.value)} autoComplete="off" /></Field>
                <Field id={`${ids}-endpoint`} label="Endpoint" className="sm:col-span-2" hint={provider === 'aws' ? 'Leave empty for AWS S3.' : undefined}>
                  <input id={`${ids}-endpoint`} className="input-m3" value={form.endpoint} onChange={(e) => set('endpoint', e.target.value)} autoComplete="off" placeholder="https://…" aria-describedby={provider === 'aws' ? `${ids}-endpoint-hint` : undefined} />
                </Field>
                <Field id={`${ids}-key`} label="Access key ID"><input id={`${ids}-key`} className="input-m3" value={form.accessKeyId} onChange={(e) => set('accessKeyId', e.target.value)} autoComplete="off" /></Field>
                <Field id={`${ids}-secret`} label="Secret access key">
                  {secretShown ? (
                    <>
                      <div className="flex gap-2">
                        <input id={`${ids}-secret`} type="password" className="input-m3" value={form.secretAccessKey} readOnly aria-describedby={`${ids}-secret-note`} />
                        <button type="button" className="btn btn-secondary" onClick={() => { setReplacing(true); set('secretAccessKey', '') }}>Replace</button>
                      </div>
                      <p id={`${ids}-secret-note`} className="mt-1.5 text-xs" style={{ color: 'var(--m3-up)' }}>Saved, stored encrypted</p>
                    </>
                  ) : (
                    <>
                      <div className="flex gap-2">
                        <input id={`${ids}-secret`} type="password" className="input-m3" value={form.secretAccessKey} onChange={(e) => set('secretAccessKey', e.target.value)} autoComplete="new-password" autoFocus={replacing} />
                        {hasSecret && <button type="button" className="btn btn-secondary" onClick={() => { setReplacing(false); set('secretAccessKey', saved.secretAccessKey) }}>Keep saved</button>}
                      </div>
                      {hasSecret && <p className="mt-1.5 text-xs" style={MUTED}>An empty value removes the saved key.</p>}
                    </>
                  )}
                </Field>
              </div>

              <div className="flex flex-wrap items-end gap-4">
                <Segmented
                  label="How often"
                  value={customInterval ? 0 : form.intervalSeconds}
                  options={[...INTERVALS.map((i) => ({ value: i.seconds, label: i.label })), { value: 0, label: 'Custom' }]}
                  onChange={(value) => { if (value === 0) setCustomInterval(true); else { setCustomInterval(false); set('intervalSeconds', value) } }}
                />
                {customInterval && (
                  <div className="flex items-center gap-2">
                    <label htmlFor={`${ids}-interval`} className="sr-only">Interval in seconds</label>
                    <input id={`${ids}-interval`} type="number" min={60} max={86400} className="input-m3 w-28" value={form.intervalSeconds} onChange={(e) => set('intervalSeconds', Number(e.target.value))} />
                    <span className="text-sm" style={MUTED}>seconds, at least 60</span>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3.5 border-t pt-5" style={{ borderColor: 'var(--m3-outline-variant)' }}>
                <button type="button" className="btn btn-secondary" disabled={!canCheck} onClick={() => checkAccess.mutate()}>
                  <span className="material-symbols-outlined" aria-hidden="true">key</span>{checkAccess.isPending ? 'Checking…' : 'Check access'}
                </button>
                {check?.ok && <span role="status" className="inline-flex items-center gap-1.5 text-[13px]" style={{ color: 'var(--m3-up)' }}><span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 18 }}>check_circle</span>Connected. The key can write to {form.bucket}.</span>}
                {check && !check.ok && <span role="status" className="inline-flex items-center gap-1.5 text-[13px]" style={{ color: 'var(--m3-on-error-container)' }}><span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 18 }}>cancel</span>{/HTTP \d{3}/.test(check.error ?? '') ? 'Rejected by the service' : 'Could not reach the service'}: {check.error}</span>}
                {!check && !canCheck && <span className="text-[13px]" style={MUTED}>Fill in the bucket and the key first.</span>}
              </div>
            </fieldset>
          </Card>

          <div className="flex min-w-0 flex-1 basis-[340px] flex-col gap-6">
            <Card aria-labelledby={`${ids}-see`}>
              <fieldset disabled={busy} className="space-y-4">
                <legend className="sr-only">What visitors see</legend>
                <h2 id={`${ids}-see`} className="font-headline text-lg font-bold">What visitors see</h2>
                <Switch
                  checked={form.showBanner}
                  onChange={(value) => set('showBanner', value)}
                  label="Show a banner on the copy"
                  description="Says when the copy was taken, and warns once it is out of date. Off makes it look like the live page; visitors then cannot tell the difference."
                />
                {form.showBanner ? (
                  <>
                    <div className="overflow-hidden rounded-xl border" style={{ borderColor: 'var(--m3-outline-variant)', background: 'var(--m3-surface)' }}>
                      <BannerSample stale={false} />
                      <BannerSample stale />
                      <div className="flex gap-2 p-4"><span className="h-2.5 flex-1 rounded" style={{ background: 'var(--admin-icon-container)' }} /><span className="h-2.5 flex-[2] rounded" style={{ background: 'var(--admin-icon-container)' }} /></div>
                    </div>
                    <p className="text-xs" style={MUTED}>Top: a fresh copy. Below: one older than three pushes.</p>
                  </>
                ) : (
                  <p className="text-xs" style={MUTED}>No banner. Visitors get no warning when the copy is old.</p>
                )}
              </fieldset>
            </Card>

          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl px-5 py-3.5" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
          <span className="text-[13px]" style={MUTED}>{dirty ? 'You have unsaved changes.' : saved.enabled || configured ? 'All changes saved.' : 'Nothing is pushed until you save with the switch on.'}</span>
          <div className="flex flex-wrap gap-2.5">
            <button type="button" className="btn btn-secondary" disabled={busy || !dirty} onClick={() => { setForm(saved); setReplacing(false); setCheck(null); setCustomInterval(!INTERVALS.some((i) => i.seconds === saved.intervalSeconds)) }}>Discard</button>
            <button type="submit" className={saved.enabled || !dirty ? 'btn btn-primary' : 'btn btn-secondary'} disabled={busy || !dirty}>{save.isPending ? 'Saving…' : 'Save'}</button>
            {!saved.enabled && (
              <button type="button" className="btn btn-primary" disabled={busy || !canCheck} onClick={() => save.mutate({ ...form, enabled: true })}>Save and turn on</button>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}
