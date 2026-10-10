import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api/client'
import { ConfirmModal } from '../components/ConfirmModal'
import { Alert, PageContainer, PageHeader, Switch, useToast } from '../components/ui'

type Action = 'create' | 'update' | 'unchanged' | 'delete'

interface Change { kind: 'channel' | 'monitor' | 'layout'; key?: string; action: Action; fields?: string[] }
interface ImportResult { dryRun: boolean; prune: boolean; summary: Record<Action, number>; changes: Change[] }
interface Problem { path: string; message: string }
interface Rejected { error: string; problems: Problem[] }
interface ChosenFile { name: string; text: string; contentType: string }

/** The server refuses a larger body; say so before sending it. */
const MAX_FILE_BYTES = 2 * 1024 * 1024

const KIND_LABEL: Record<Change['kind'], string> = { monitor: 'Monitor', channel: 'Notification channel', layout: 'Status page layout' }
const ACTION_LABEL: Record<Action, string> = { create: 'Create', update: 'Update', delete: 'Remove', unchanged: 'No change' }
const ACTION_STYLE: Record<Action, { background: string; color: string }> = {
  create: { background: 'var(--m3-up-bg)', color: 'var(--m3-up)' },
  update: { background: 'var(--m3-degraded-bg)', color: 'var(--m3-degraded)' },
  delete: { background: 'var(--m3-down-bg)', color: 'var(--m3-down)' },
  unchanged: { background: 'var(--m3-surface-container-high)', color: 'var(--m3-secondary)' },
}

const CARD = { background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('The file could not be read'))
    reader.readAsText(file)
  })
}

/** The list of problems the server sends with a 400 for a file it will not apply. */
function rejection(error: unknown): Rejected | null {
  if (!(error instanceof ApiError)) return null
  const body = error.body as Partial<Rejected> | undefined
  return body?.problems?.length ? { error: body.error ?? error.message, problems: body.problems } : null
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

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
  const { create, update, delete: removed, unchanged } = result.summary
  const parts = [
    create && `${create} to create`,
    update && `${update} to update`,
    removed && `${removed} to remove`,
    unchanged && `${unchanged} unchanged`,
  ].filter(Boolean)
  return <p className="text-sm" style={{ color: 'var(--m3-on-surface)' }}>{parts.length ? parts.join(' · ') : 'The file describes nothing.'}</p>
}

export default function ConfigurationPage() {
  const toast = useToast()
  const [format, setFormat] = useState<'yaml' | 'json'>('yaml')
  const [file, setFile] = useState<ChosenFile | null>(null)
  const [prune, setPrune] = useState(false)
  const [allowEmpty, setAllowEmpty] = useState(false)
  const [checking, setChecking] = useState(false)
  const [preview, setPreview] = useState<ImportResult | null>(null)
  const [rejected, setRejected] = useState<Rejected | null>(null)
  const [failure, setFailure] = useState('')
  const [applying, setApplying] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [applied, setApplied] = useState<ImportResult | null>(null)
  const input = useRef<HTMLInputElement>(null)
  /** Only the answer to the latest question is shown; an earlier, slower one is dropped. */
  const latest = useRef(0)

  const query = `?prune=${prune}&allowEmpty=${prune && allowEmpty}`

  const check = useCallback(async () => {
    if (!file) return
    const ticket = ++latest.current
    setChecking(true)
    setFailure('')
    try {
      const result = await api.postText<ImportResult>(`/admin/config/validate${query}`, file.text, file.contentType)
      if (ticket !== latest.current) return
      setPreview(result)
      setRejected(null)
    } catch (error) {
      if (ticket !== latest.current) return
      setPreview(null)
      const problems = rejection(error)
      if (problems) setRejected(problems)
      else { setRejected(null); setFailure(error instanceof Error ? error.message : 'The file could not be checked') }
    } finally {
      if (ticket === latest.current) setChecking(false)
    }
  }, [file, query])

  // Checking is cheap and writes nothing, so it runs whenever the file or an option changes.
  useEffect(() => { void check() }, [check])

  async function choose(selected: File) {
    setApplied(null)
    setPreview(null)
    setRejected(null)
    setFailure('')
    if (selected.size > MAX_FILE_BYTES) {
      setFile(null)
      setFailure(`${selected.name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB, which is more than a configuration needs.`)
      return
    }
    try {
      const text = await readText(selected)
      setFile({ name: selected.name, text, contentType: /\.json$/i.test(selected.name) ? 'application/json' : 'application/yaml' })
    } catch (error) {
      setFile(null)
      setFailure(error instanceof Error ? error.message : 'The file could not be read')
    }
  }

  async function apply() {
    if (!file) return
    setApplying(true)
    try {
      const result = await api.postText<ImportResult>(`/admin/config/apply${query}`, file.text, file.contentType)
      latest.current += 1 // an answer to an earlier check must not bring the preview back
      setApplied(result)
      setPreview(null)
      setConfirming(false)
    } catch (error) {
      setConfirming(false)
      const problems = rejection(error)
      if (problems) setRejected(problems)
      else toast.error(error instanceof Error ? error.message : 'The file could not be applied')
    } finally {
      setApplying(false)
    }
  }

  async function download() {
    try {
      await api.download(`/admin/config/export?format=${format}`, `bsp-config.${format}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The export failed')
    }
  }

  const changes = preview?.changes.filter((change) => change.action !== 'unchanged') ?? []
  const removals = preview?.changes.filter((change) => change.action === 'delete') ?? []
  const nothingToDo = !!preview && changes.length === 0
  const removalText = (() => {
    const monitorCount = removals.filter((change) => change.kind === 'monitor').length
    const channelCount = removals.filter((change) => change.kind === 'channel').length
    return [monitorCount && plural(monitorCount, 'monitor', 'monitors'), channelCount && plural(channelCount, 'notification channel', 'notification channels')].filter(Boolean).join(' and ')
  })()

  return (
    <PageContainer>
      <PageHeader title="Configuration" subtitle="Monitors, notification channels and the status page layout as a file" />

      <section className="rounded-2xl p-5 space-y-3" style={CARD} aria-labelledby="export-heading">
        <h2 id="export-heading" className="font-headline font-semibold text-sm" style={{ color: 'var(--m3-on-surface)' }}>Export</h2>
        <p className="text-sm max-w-2xl" style={{ color: 'var(--m3-secondary)' }}>
          Download the configuration as one file for version control or another installation. Saved passwords, tokens and Slack, Discord and Teams webhook URLs are written as <code className="font-mono">••••••••</code>, never with their value.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <select aria-label="Export format" value={format} onChange={(e) => setFormat(e.target.value as 'yaml' | 'json')} className="input-sig w-auto">
            <option value="yaml">YAML</option>
            <option value="json">JSON</option>
          </select>
          <button type="button" onClick={() => void download()} className="btn btn-primary">
            <span className="material-symbols-outlined" aria-hidden="true">download</span>
            Download
          </button>
        </div>
      </section>

      <section className="rounded-2xl p-5 space-y-4" style={CARD} aria-labelledby="import-heading">
        <h2 id="import-heading" className="font-headline font-semibold text-sm" style={{ color: 'var(--m3-on-surface)' }}>Import</h2>
        <p className="text-sm max-w-2xl" style={{ color: 'var(--m3-secondary)' }}>
          Choose a YAML or JSON file to see what it would change. Nothing is written until you apply it, and a file is applied completely or not at all.
          A secret written as <code className="font-mono">••••••••</code> keeps the stored one.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => input.current?.click()} className="btn btn-secondary">
            <span className="material-symbols-outlined" aria-hidden="true">upload_file</span>
            {file ? 'Choose another file' : 'Choose file'}
          </button>
          <input
            ref={input}
            className="hidden"
            type="file"
            accept=".yaml,.yml,.json"
            aria-label="Configuration file"
            onChange={(e) => { const selected = e.target.files?.[0]; if (selected) void choose(selected); e.target.value = '' }}
          />
          {file && <span className="font-mono text-xs" style={{ color: 'var(--m3-secondary)' }}>{file.name}</span>}
        </div>

        <div className="space-y-3 max-w-2xl">
          <Switch
            label="Remove what the file leaves out"
            description="Monitors and notification channels missing from a section of the file are removed, with their history. Sections the file does not have are left alone."
            checked={prune}
            onChange={(next) => { setPrune(next); if (!next) setAllowEmpty(false) }}
          />
          <Switch
            label="Allow a section that is empty"
            description="Needed when the file has an empty list of monitors or channels and you do want every one of them removed."
            checked={prune && allowEmpty}
            disabled={!prune}
            onChange={setAllowEmpty}
          />
        </div>

        {failure && <Alert tone="error" onDismiss={() => setFailure('')}>{failure}</Alert>}

        {checking && <p className="text-sm" style={{ color: 'var(--m3-secondary)' }} role="status">Checking {file?.name}…</p>}

        {rejected && (
          <Alert tone="error" title="This file cannot be applied. Nothing was changed.">
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
              ? <Alert tone="info">The installation already matches this file. There is nothing to apply.</Alert>
              : <ChangeTable changes={changes} />}
            {!nothingToDo && (
              <div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={applying}
                  onClick={() => (removals.length ? setConfirming(true) : void apply())}
                >
                  {applying && !confirming ? 'Applying…' : 'Apply changes'}
                </button>
              </div>
            )}
          </div>
        )}

        {applied && (
          <div className="space-y-3">
            <Alert tone="success" title="The configuration was applied." onDismiss={() => setApplied(null)}>
              <Summary result={applied} />
            </Alert>
            {applied.changes.some((change) => change.action !== 'unchanged') && <ChangeTable changes={applied.changes.filter((change) => change.action !== 'unchanged')} />}
          </div>
        )}
      </section>

      {confirming && (
        <ConfirmModal
          title="Remove from the installation?"
          message={`Applying this file removes ${removalText} that ${removals.length === 1 ? 'is' : 'are'} not in it, with ${removals.length === 1 ? 'its' : 'their'} history. This cannot be undone.`}
          confirmLabel="Apply and remove"
          pending={applying}
          pendingLabel="Applying…"
          onConfirm={() => void apply()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </PageContainer>
  )
}
