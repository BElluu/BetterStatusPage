import { useEffect, useId, useState } from 'react'
import { api } from '../../api/client'
import type { Action, NotificationChannel } from '@bsp/shared'
import { CHANNEL_TYPES } from '../notifications/channelTypes'
import type { VaultPickerProps } from '../monitors/monitorFormParts'
import { ModalFooter, ModalHeader, ModalShell } from '../ModalShell'
import { SidePanelFrame, SideTabStrip, type SidePanelMeta, type SideTab } from '../SidePanel'
import { YamlViewModal } from '../YamlViewModal'
import { Alert, Field, Switch } from '../ui'

interface Props {
  action: Action | null
  onClose: () => void
  onSaved: () => void
}

/** An HTTP action is edited with the same fields as a webhook channel: URL, method, headers and body. */
const http = CHANNEL_TYPES.webhook
const NO_VAULT: VaultPickerProps = { vaults: [], secretsByVault: {}, onLoadSecrets: async () => {} }

type ActionPanelKey = 'secrets' | 'notify'

const PANEL_META: Record<ActionPanelKey, SidePanelMeta> = {
  secrets: { icon: 'key', label: 'Secrets' },
  notify: { icon: 'notifications', label: 'Notify when a run fails' },
}

/** A vault secret the action reads, as the form edits it: `secretId` 0 means none chosen yet. */
interface SecretRow { name: string; vaultId: number; secretId: number }

const SECRET_NAME = /^[A-Za-z][A-Za-z0-9]{0,23}$/

interface TestOutcome { ok: boolean; text: string; status?: number | undefined; snippet?: string | undefined }

/** What a header or URL looks like when it carries a credential in plain text instead of a vault placeholder. */
function looksLikePlainCredential(draft: { url: string; headers: [string, string][] }): boolean {
  const inHeader = draft.headers.some(([name, value]) => /auth|token|secret|key|pass/i.test(name) && value.trim() !== '' && !value.includes('{{'))
  const inUrl = /[?&](token|key|secret|password|api_?key)=[^&{]+/i.test(draft.url)
  return inHeader || inUrl
}

/** The placeholders a secret of this type gives under this name. */
function placeholdersOf(name: string, type: string | undefined): string[] {
  const n = name || 'name'
  if (type === 'userpass') return [`{{secret_${n}_basic}}`, `{{secret_${n}_username}}`, `{{secret_${n}_password}}`]
  if (type === 'json') return [`{{secret_${n}_<key>}}`]
  return [`{{secret_${n}}}`]
}

/** What the server would refuse about the secrets, found before anything is saved. */
function secretsProblem(rows: SecretRow[]): string | null {
  const seen = new Set<string>()
  for (const row of rows) {
    if (!SECRET_NAME.test(row.name)) return 'Each secret needs a name of letters and digits (up to 24, starting with a letter).'
    if (seen.has(row.name)) return `The secret name "${row.name}" is used twice.`
    seen.add(row.name)
    if (!row.secretId) return `Choose a vault secret for "${row.name}".`
  }
  return null
}

export default function ActionFormModal({ action, onClose, onSaved }: Props) {
  const isEdit = !!action
  const titleId = useId()
  const testHintId = useId()
  const [name, setName]       = useState(action?.name ?? '')
  const [enabled, setEnabled] = useState((action?.enabled ?? 1) === 1)
  const [draft, setDraft]     = useState(() => action
    ? { ...http.parse(action.config as unknown as Record<string, unknown>), body: action.config.body ?? '' }
    : { ...http.defaultDraft(), body: '' })
  const [secrets, setSecrets] = useState<SecretRow[]>(() =>
    (action?.config.secrets ?? []).map((s) => ({ name: s.name, vaultId: s.vault.vaultId, secretId: s.vault.secretId })))
  const [failureChannelIds, setFailureChannelIds] = useState<number[]>(action?.failureChannelIds ?? [])
  const [channels, setChannels] = useState<NotificationChannel[]>([])
  const [vaults, setVaults]     = useState<VaultPickerProps['vaults']>([])
  const [secretsByVault, setSecretsByVault] = useState<VaultPickerProps['secretsByVault']>({})
  const [sidePanel, setSidePanel] = useState<ActionPanelKey | null>(null)
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState<TestOutcome | null>(null)
  const [error, setError]     = useState('')
  const [showYaml, setShowYaml] = useState(false)

  async function loadSecrets(vaultId: number) {
    if (!vaultId || secretsByVault[vaultId]) return
    try {
      const list = await api.get<VaultPickerProps['secretsByVault'][number]>(`/admin/vaults/${vaultId}/secrets`)
      setSecretsByVault((prev) => ({ ...prev, [vaultId]: list }))
    } catch { /* the picker shows an empty secret list */ }
  }
  useEffect(() => {
    api.get<NotificationChannel[]>('/admin/notifications/channels').then(setChannels).catch(() => {})
    api.get<VaultPickerProps['vaults']>('/admin/vaults').then(setVaults).catch(() => {})
    for (const vaultId of new Set(secrets.map((s) => s.vaultId))) void loadSecrets(vaultId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateSecret = (index: number, patch: Partial<SecretRow>) =>
    setSecrets((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  const addSecret = () => {
    const taken = new Set(secrets.map((s) => s.name))
    let n = 1
    while (taken.has(n === 1 ? 'token' : `token${n}`)) n++
    setSecrets((rows) => [...rows, { name: n === 1 ? 'token' : `token${n}`, vaultId: 0, secretId: 0 }])
  }

  const buildConfig = () => ({
    ...http.build(draft),
    ...(secrets.length ? { secrets: secrets.map((s) => ({ name: s.name, vault: { vaultId: s.vaultId, secretId: s.secretId } })) } : {}),
  })

  // "Run now" sends the stored action, so it is only meaningful while the form matches it.
  const snapshot = JSON.stringify({ name, enabled, config: buildConfig(), failureChannelIds })
  const [savedSnapshot] = useState(snapshot)
  const dirty = snapshot !== savedSnapshot

  const sideTabs: SideTab<ActionPanelKey>[] = [
    { key: 'secrets', badge: secrets.length > 0 ? String(secrets.length) : null },
    { key: 'notify',  badge: failureChannelIds.length > 0 ? String(failureChannelIds.length) : null },
  ]

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (draft.method !== 'GET' && draft.body.trim()) {
      try { JSON.parse(draft.body) } catch {
        setError('The body must be valid JSON, with {{variables}} inside string values, for example {"monitor": "{{monitor_name}}"}.')
        return
      }
    }
    const problem = secretsProblem(secrets)
    if (problem) {
      setSidePanel('secrets')
      setError(problem)
      return
    }
    setLoading(true)
    try {
      const body = { name, enabled: enabled ? 1 : 0, config: buildConfig(), failureChannelIds }
      if (isEdit) await api.patch(`/admin/actions/${action.id}`, body)
      else await api.post('/admin/actions', body)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleTest() {
    if (!action) return
    setTesting(true)
    setTestMsg(null)
    try {
      const result = await api.post<{ status?: number; snippet?: string }>(`/admin/actions/${action.id}/test`, {})
      setTestMsg({ ok: true, text: `The request was answered with HTTP ${result.status ?? ''}.`, status: result.status, snippet: result.snippet })
    } catch (err) {
      // A failed request answers 422 with what the target said, next to the error.
      const body = (err as { body?: { status?: number; snippet?: string } }).body
      setTestMsg({ ok: false, text: err instanceof Error ? err.message : 'Request failed', status: body?.status, snippet: body?.snippet })
    } finally {
      setTesting(false)
    }
  }

  const toggleChannel = (id: number, on: boolean) =>
    setFailureChannelIds((prev) => (on ? [...new Set([...prev, id])] : prev.filter((existing) => existing !== id)))

  return (
    <ModalShell align="top" onClose={loading ? undefined : onClose} labelledBy={titleId}>
      <div
        className="rounded-2xl my-8 flex flex-col lg:flex-row"
        style={{
          width: sidePanel ? 'min(1024px, calc(100vw - 32px))' : 'min(620px, calc(100vw - 32px))',
          background: 'var(--m3-surface-container-low)',
          border: '1px solid var(--m3-outline-variant)',
          transition: 'width 0.2s ease',
        }}
      >
        <div className={`flex-none min-w-0 w-full ${sidePanel ? 'lg:w-[560px]' : 'lg:w-[calc(100%-44px)]'}`}>
          <ModalHeader icon="bolt" titleId={titleId} title={isEdit ? 'Edit Action' : 'New Action'} onClose={onClose} />
          <form onSubmit={handleSubmit}>
            <div className="p-4 sm:p-6 space-y-4">
              {error && <Alert tone="error">{error}</Alert>}

              <Field label="Name">
                <input value={name} onChange={(e) => setName(e.target.value)} required className="input-sig" placeholder="Start VM2" />
              </Field>

              <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

              <http.Fields draft={draft} onChange={setDraft} vaultPicker={NO_VAULT} />

              {secrets.length === 0 && looksLikePlainCredential(draft) && (
                <Alert tone="warning">
                  A header or the URL looks like it holds a credential in plain text. Keep it in a vault secret (Secrets tab) and use its placeholder instead.
                </Alert>
              )}

              <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

              <Switch label="Enabled" checked={enabled} onChange={setEnabled} />

              {testMsg && (
                <Alert tone={testMsg.ok ? 'success' : 'error'}>
                  {testMsg.text}
                  {testMsg.snippet && <pre className="mt-2 text-xs whitespace-pre-wrap break-words font-mono">{testMsg.snippet}</pre>}
                </Alert>
              )}
              {isEdit && dirty && (
                <p id={testHintId} className="text-xs text-right" style={{ color: 'var(--m3-secondary)' }}>
                  Save your changes first — Run now uses the saved action.
                </p>
              )}
            </div>

            <ModalFooter
              start={isEdit ? <>
                <button type="button" onClick={() => setShowYaml(true)} title="The saved action as YAML" className="btn btn-secondary">
                  <span className="material-symbols-outlined" aria-hidden="true">data_object</span>
                  YAML
                </button>
                <button type="button" onClick={handleTest} disabled={testing || dirty}
                  aria-describedby={dirty ? testHintId : undefined}
                  title="Sends the real request, so whatever it triggers starts"
                  className="btn btn-secondary"
                >
                  {testing
                    ? <><span className="material-symbols-outlined animate-spin" aria-hidden="true">progress_activity</span> Sending…</>
                    : 'Run now (saved settings)'}
                </button>
              </> : undefined}
            >
              <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
              <button type="submit" disabled={loading} className="btn btn-primary">
                {loading ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Action'}
              </button>
            </ModalFooter>
          </form>
        </div>

        {sidePanel === 'secrets' && (
          <SidePanelFrame meta={PANEL_META.secrets} layout="responsive">
            <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>
              Read tokens and passwords from a vault instead of typing them into a header, the URL or the body. Give each secret a name, then use
              its placeholder anywhere in the request. The secret is read when the request is sent and is never stored with the action.
            </p>
            {vaults.length === 0 && <Alert tone="info">There is no vault yet. Create one under Administration → Vault.</Alert>}
            {secrets.map((row, index) => {
              const list = secretsByVault[row.vaultId]
              const type = list?.find((s) => s.id === row.secretId)?.type
              return (
                <div key={index} className="rounded-lg px-3 py-3 space-y-3" style={{ border: '1px solid var(--m3-outline-variant)' }}>
                  <div className="flex items-end gap-2">
                    <div className="flex-1 min-w-0">
                      <Field label="Name">
                        <input value={row.name} onChange={(e) => updateSecret(index, { name: e.target.value })} className="input-sig" placeholder="token" autoComplete="off" />
                      </Field>
                    </div>
                    <button type="button" onClick={() => setSecrets((rows) => rows.filter((_, i) => i !== index))}
                      aria-label={`Remove secret ${row.name || index + 1}`} className="btn-icon w-8 h-8 mb-1">
                      <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '16px' }}>close</span>
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Vault">
                      <select className="input-sig" value={row.vaultId || ''}
                        onChange={(e) => { const id = Number(e.target.value); void loadSecrets(id); updateSecret(index, { vaultId: id, secretId: 0 }) }}>
                        <option value="">— select vault —</option>
                        {vaults.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </select>
                    </Field>
                    <Field label="Secret">
                      <select className="input-sig" value={row.secretId || ''} disabled={!row.vaultId}
                        onChange={(e) => updateSecret(index, { secretId: Number(e.target.value) })}>
                        <option value="">— select secret —</option>
                        {(list ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.type})</option>)}
                      </select>
                    </Field>
                  </div>
                  {row.secretId > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {placeholdersOf(row.name, type).map((placeholder) => (
                        <code key={placeholder} className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--m3-surface-container-high)', color: 'var(--m3-primary)', fontFamily: 'monospace' }}>{placeholder}</code>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
            <button type="button" onClick={addSecret} className="btn btn-outline btn-sm">+ Add secret</button>
          </SidePanelFrame>
        )}

        {sidePanel === 'notify' && (
          <SidePanelFrame meta={PANEL_META.notify} layout="responsive">
            <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>
              Each channel you tick is told once, after the last attempt of a run has failed. Nothing is sent for a success or a cancelled run.
            </p>
            {channels.length === 0 && <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>No notification channels configured. Create one in the Notifications section.</p>}
            {channels.map((channel) => (
              <label key={channel.id} className="flex items-center gap-3 cursor-pointer select-none rounded-lg px-3 py-2" style={{ border: '1px solid var(--m3-outline-variant)' }}>
                <input type="checkbox" className="w-4 h-4 rounded" checked={failureChannelIds.includes(channel.id)} onChange={(e) => toggleChannel(channel.id, e.target.checked)} />
                <span className="text-sm flex-1" style={{ color: 'var(--m3-on-surface)' }}>{channel.name}</span>
                {!channel.enabled && <span className="text-xs" style={{ color: 'var(--m3-secondary)' }}>disabled</span>}
              </label>
            ))}
          </SidePanelFrame>
        )}

        <SideTabStrip tabs={sideTabs} meta={PANEL_META} active={sidePanel} onToggle={setSidePanel} layout="responsive" />
      </div>
      {showYaml && action && <YamlViewModal kind="Action" objectKey={action.key} title={action.name} onClose={() => setShowYaml(false)} />}
    </ModalShell>
  )
}
