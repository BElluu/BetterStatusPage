import { useId, useState } from 'react'
import { api } from '../../api/client'
import type { Action } from '@bsp/shared'
import { CHANNEL_TYPES } from '../notifications/channelTypes'
import { ModalFooter, ModalHeader, ModalShell } from '../ModalShell'
import { Alert, Field, Switch } from '../ui'

interface Props {
  action: Action | null
  onClose: () => void
  onSaved: () => void
}

/** An HTTP action is edited with the same fields as a webhook channel: URL, method, headers and body. */
const http = CHANNEL_TYPES.webhook
const NO_VAULT = { vaults: [], secretsByVault: {}, onLoadSecrets: async () => {} }

export default function ActionFormModal({ action, onClose, onSaved }: Props) {
  const isEdit = !!action
  const titleId = useId()
  const testHintId = useId()
  const [name, setName]       = useState(action?.name ?? '')
  const [enabled, setEnabled] = useState((action?.enabled ?? 1) === 1)
  const [draft, setDraft]     = useState(() => action
    ? { ...http.parse(action.config as unknown as Record<string, unknown>), body: action.config.body ?? '' }
    : { ...http.defaultDraft(), body: '' })
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [error, setError]     = useState('')

  // "Run now" sends the stored action, so it is only meaningful while the form matches it.
  const snapshot = JSON.stringify({ name, enabled, config: http.build(draft) })
  const [savedSnapshot] = useState(snapshot)
  const dirty = snapshot !== savedSnapshot

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (draft.method !== 'GET' && draft.body.trim()) {
      try { JSON.parse(draft.body) } catch {
        setError('The body must be valid JSON, with {{variables}} inside string values, for example {"monitor": "{{monitor_name}}"}.')
        return
      }
    }
    setLoading(true)
    try {
      const body = { name, enabled: enabled ? 1 : 0, config: http.build(draft) }
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
      await api.post(`/admin/actions/${action.id}/test`, {})
      setTestMsg({ ok: true, text: 'The request was sent and answered with a success status.' })
    } catch (err) {
      setTestMsg({ ok: false, text: err instanceof Error ? err.message : 'Request failed' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <ModalShell align="top" onClose={loading ? undefined : onClose} labelledBy={titleId}>
      <div className="rounded-2xl my-8" style={{ width: 'min(620px, calc(100vw - 32px))', background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
        <ModalHeader icon="bolt" titleId={titleId} title={isEdit ? 'Edit Action' : 'New Action'} onClose={onClose} />
        <form onSubmit={handleSubmit}>
          <div className="p-4 sm:p-6 space-y-4">
            {error && <Alert tone="error">{error}</Alert>}

            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} required className="input-sig" placeholder="Start VM2" />
            </Field>

            <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

            <http.Fields draft={draft} onChange={setDraft} vaultPicker={NO_VAULT} />

            <div style={{ borderTop: '1px solid var(--m3-outline-variant)' }} />

            <Switch label="Enabled" checked={enabled} onChange={setEnabled} />

            {testMsg && <Alert tone={testMsg.ok ? 'success' : 'error'}>{testMsg.text}</Alert>}
            {isEdit && dirty && (
              <p id={testHintId} className="text-xs text-right" style={{ color: 'var(--m3-secondary)' }}>
                Save your changes first — Run now uses the saved action.
              </p>
            )}
          </div>

          <ModalFooter
            start={isEdit ? (
              <button type="button" onClick={handleTest} disabled={testing || dirty}
                aria-describedby={dirty ? testHintId : undefined}
                title="Sends the real request, so whatever it triggers starts"
                className="btn btn-secondary"
              >
                {testing
                  ? <><span className="material-symbols-outlined animate-spin" aria-hidden="true">progress_activity</span> Sending…</>
                  : 'Run now (saved settings)'}
              </button>
            ) : undefined}
          >
            <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={loading} className="btn btn-primary">
              {loading ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Action'}
            </button>
          </ModalFooter>
        </form>
      </div>
    </ModalShell>
  )
}
