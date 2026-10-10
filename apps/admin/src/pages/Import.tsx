import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api/client'
import { Alert, PageContainer, PageHeader, useToast } from '../components/ui'

type Action = 'create' | 'update' | 'unchanged'
type Kind = 'Monitor' | 'NotificationChannel'

interface Change { kind: Kind; key?: string; action: Action; fields?: string[] }
interface ImportResult { dryRun: boolean; summary: Record<Action, number>; changes: Change[] }
interface Problem { path: string; message: string }
interface Rejected { error: string; problems: Problem[] }

/** The server refuses a larger body; say so before sending it. */
const MAX_BYTES = 2 * 1024 * 1024
/** How long to wait after typing before the text is checked. */
const CHECK_DELAY_MS = 400

const KIND_LABEL: Record<Kind, string> = { Monitor: 'Monitor', NotificationChannel: 'Notification channel' }
const ACTION_LABEL: Record<Action, string> = { create: 'Create', update: 'Update', unchanged: 'No change' }
const ACTION_STYLE: Record<Action, { background: string; color: string }> = {
  create: { background: 'var(--m3-up-bg)', color: 'var(--m3-up)' },
  update: { background: 'var(--m3-degraded-bg)', color: 'var(--m3-degraded)' },
  unchanged: { background: 'var(--m3-surface-container-high)', color: 'var(--m3-secondary)' },
}

const CARD = { background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }

const EXAMPLE = `kind: Monitor
key: public-site
name: Public site
type: https
config:
  url: https://example.com
  method: GET
  expectedStatus: 200`

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('The file could not be read'))
    reader.readAsText(file)
  })
}

/** The list of problems the server sends with a 400 for text it will not apply. */
function rejection(error: unknown): Rejected | null {
  if (!(error instanceof ApiError)) return null
  const body = error.body as Partial<Rejected> | undefined
  return body?.problems?.length ? { error: body.error ?? error.message, problems: body.problems } : null
}

function ChangeTable({ changes }: { changes: Change[] }) {
  return (
    <div className="rounded-xl overflow-x-auto" style={{ border: '1px solid var(--m3-outline-variant)' }}>
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr style={{ background: 'var(--m3-surface-container)' }}>
            {['Change', 'What', 'Key', 'Settings'].map((heading) => (
              <th key={heading} className="px-4 py-2.5 font-mono text-xs uppercase tracking-wider text-left" style={{ color: 'var(--m3-secondary)' }}>{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {changes.map((change, index) => (
            <tr key={`${change.kind}:${change.key ?? ''}:${index}`} style={{ borderTop: index > 0 ? '1px solid var(--m3-outline-variant)' : 'none' }}>
              <td className="px-4 py-2.5">
                <span className="text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap" style={ACTION_STYLE[change.action]}>{ACTION_LABEL[change.action]}</span>
              </td>
              <td className="px-4 py-2.5" style={{ color: 'var(--m3-on-surface)' }}>{KIND_LABEL[change.kind]}</td>
              <td className="px-4 py-2.5 font-mono text-xs" style={{ color: 'var(--m3-secondary)' }}>{change.key ?? '–'}</td>
              <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--m3-secondary)' }}>{change.fields?.join(', ') ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Summary({ result }: { result: ImportResult }) {
  const { create, update, unchanged } = result.summary
  const parts = [create && `${create} to create`, update && `${update} to update`, unchanged && `${unchanged} unchanged`].filter(Boolean)
  return <p className="text-sm" style={{ color: 'var(--m3-on-surface)' }}>{parts.length ? parts.join(' · ') : 'There is nothing in it.'}</p>
}

export default function ImportPage() {
  const toast = useToast()
  const [text, setText] = useState('')
  const [checking, setChecking] = useState(false)
  const [preview, setPreview] = useState<ImportResult | null>(null)
  const [rejected, setRejected] = useState<Rejected | null>(null)
  const [failure, setFailure] = useState('')
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState<ImportResult | null>(null)
  const input = useRef<HTMLInputElement>(null)
  /** Only the answer to the latest question is shown; an earlier, slower one is dropped. */
  const latest = useRef(0)

  const check = useCallback(async (body: string) => {
    const ticket = ++latest.current
    if (!body.trim()) {
      setChecking(false)
      setPreview(null)
      setRejected(null)
      return
    }
    setChecking(true)
    setFailure('')
    try {
      const result = await api.postText<ImportResult>('/admin/config/validate', body, 'application/yaml')
      if (ticket !== latest.current) return
      setPreview(result)
      setRejected(null)
    } catch (error) {
      if (ticket !== latest.current) return
      setPreview(null)
      const problems = rejection(error)
      if (problems) setRejected(problems)
      else { setRejected(null); setFailure(error instanceof Error ? error.message : 'It could not be checked') }
    } finally {
      if (ticket === latest.current) setChecking(false)
    }
  }, [])

  // Checking is cheap and writes nothing, so it runs after every pause in typing.
  useEffect(() => {
    const timer = setTimeout(() => void check(text), CHECK_DELAY_MS)
    return () => clearTimeout(timer)
  }, [text, check])

  function edit(next: string) {
    setApplied(null)
    setFailure('')
    // What was previewed is no longer what is in the box: hide it, and drop an answer that is still on its way.
    latest.current += 1
    setPreview(null)
    setRejected(null)
    if (next.length > MAX_BYTES) {
      setFailure(`That is larger than ${MAX_BYTES / 1024 / 1024} MB, which is more than a configuration needs.`)
      return
    }
    setText(next)
  }

  async function choose(file: File) {
    if (file.size > MAX_BYTES) {
      setFailure(`${file.name} is larger than ${MAX_BYTES / 1024 / 1024} MB, which is more than a configuration needs.`)
      return
    }
    try {
      edit(await readText(file))
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The file could not be read')
    }
  }

  async function apply() {
    setApplying(true)
    try {
      const result = await api.postText<ImportResult>('/admin/config/apply', text, 'application/yaml')
      latest.current += 1 // an answer to an earlier check must not bring the preview back
      setApplied(result)
      setPreview(null)
      setText('')
    } catch (error) {
      const problems = rejection(error)
      if (problems) setRejected(problems)
      else toast.error(error instanceof Error ? error.message : 'It could not be applied')
    } finally {
      setApplying(false)
    }
  }

  const changes = preview?.changes.filter((change) => change.action !== 'unchanged') ?? []
  const nothingToDo = !!preview && changes.length === 0

  return (
    <PageContainer>
      <PageHeader title="Import" subtitle="Create or update monitors and notification channels from YAML" />

      <section className="rounded-2xl p-5 space-y-4" style={CARD} aria-labelledby="import-heading">
        <h2 id="import-heading" className="font-headline font-semibold text-sm" style={{ color: 'var(--m3-on-surface)' }}>YAML</h2>
        <p className="text-sm max-w-2xl" style={{ color: 'var(--m3-secondary)' }}>
          Paste one or more documents, separated by <code className="font-mono">---</code>, or choose a file. Each document starts with its
          {' '}<code className="font-mono">kind</code>: <code className="font-mono">Monitor</code> or <code className="font-mono">NotificationChannel</code>. An object whose <code className="font-mono">key</code> exists is updated, any other is created.
          Nothing is deleted. Nothing is written until you apply, and what you apply takes effect completely or not at all.
          A secret written as <code className="font-mono">••••••••</code> keeps the stored one. To start from an existing object, open it and choose <strong>YAML</strong>.
        </p>
        <p className="text-sm max-w-2xl" style={{ color: 'var(--m3-secondary)' }}>
          Importing needs the Operator role.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => input.current?.click()} className="btn btn-secondary">
            <span className="material-symbols-outlined" aria-hidden="true">upload_file</span>
            Choose file
          </button>
          <input
            ref={input}
            className="hidden"
            type="file"
            accept=".yaml,.yml"
            aria-label="Configuration file"
            onChange={(e) => { const selected = e.target.files?.[0]; if (selected) void choose(selected); e.target.value = '' }}
          />
          <button type="button" onClick={() => edit('')} disabled={!text} className="btn btn-ghost">Clear</button>
        </div>

        <textarea
          aria-label="Configuration to import"
          value={text}
          onChange={(e) => edit(e.target.value)}
          placeholder={EXAMPLE}
          spellCheck={false}
          rows={14}
          className="input-sig w-full font-mono text-xs"
          style={{ resize: 'vertical' }}
        />

        {failure && <Alert tone="error" onDismiss={() => setFailure('')}>{failure}</Alert>}

        {checking && <p className="text-sm" style={{ color: 'var(--m3-secondary)' }} role="status">Checking…</p>}

        {rejected && !checking && (
          <Alert tone="error" title="This cannot be applied. Nothing was changed.">
            <ul className="mt-1 space-y-1 list-disc pl-5">
              {rejected.problems.map((problem, index) => (
                <li key={`${problem.path}:${index}`}><code className="font-mono text-xs">{problem.path}</code>: {problem.message}</li>
              ))}
            </ul>
          </Alert>
        )}

        {preview && !checking && (
          <div className="space-y-3">
            <Summary result={preview} />
            {nothingToDo
              ? <Alert tone="info">The installation already matches this. There is nothing to apply.</Alert>
              : <ChangeTable changes={changes} />}
            {!nothingToDo && (
              <div>
                <button type="button" className="btn btn-primary" disabled={applying} onClick={() => void apply()}>
                  {applying ? 'Applying…' : 'Apply changes'}
                </button>
              </div>
            )}
          </div>
        )}

        {applied && (
          <div className="space-y-3">
            <Alert tone="success" title="Applied." onDismiss={() => setApplied(null)}>
              <Summary result={applied} />
            </Alert>
            {applied.changes.some((change) => change.action !== 'unchanged') && <ChangeTable changes={applied.changes.filter((change) => change.action !== 'unchanged')} />}
          </div>
        )}
      </section>
    </PageContainer>
  )
}
